import { query } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

interface ArchiveTableSpec {
  tableName: string;
  idColumn: string;
  vaultJoinColumn: "contract_id" | "vault_id";
  retentionDays: number;
  timestampColumn: string;
}

const ARCHIVE_TABLES: ArchiveTableSpec[] = [
  {
    tableName: "indexed_events",
    idColumn: "id",
    vaultJoinColumn: "contract_id",
    retentionDays: 90,
    timestampColumn: "created_at",
  },
  {
    tableName: "share_balance_snapshots",
    idColumn: "id",
    vaultJoinColumn: "vault_id",
    retentionDays: 365,
    timestampColumn: "recorded_at",
  },
  {
    tableName: "vault_tvl_snapshots",
    idColumn: "id",
    vaultJoinColumn: "vault_id",
    retentionDays: 365,
    timestampColumn: "recorded_at",
  },
];

async function ensureArchiveTable(liveTable: string): Promise<void> {
  const archiveTable = `${liveTable}_archive`;
  await query(
    `CREATE TABLE IF NOT EXISTS ${archiveTable} (LIKE ${liveTable} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
  );
}

function getRetentionDays(spec: ArchiveTableSpec): number {
  if (spec.tableName === "indexed_events") {
    return config.eventsRetentionDays;
  }
  return spec.retentionDays;
}

function buildCountQuery(spec: ArchiveTableSpec, retentionDays: number): string {
  const excludedVaultsJoin = `
    LEFT JOIN vaults v ON v.${spec.vaultJoinColumn} = t.${spec.vaultJoinColumn}
  `;
  const excludedVaultsWhere = `AND (v.exclude_from_archive IS NULL OR v.exclude_from_archive = FALSE)`;

  if (spec.vaultJoinColumn === "contract_id") {
    return `
      SELECT COUNT(*)::text AS count
      FROM ${spec.tableName} t
      ${excludedVaultsJoin}
      WHERE t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
        ${excludedVaultsWhere}
    `;
  }

  return `
    SELECT COUNT(*)::text AS count
    FROM ${spec.tableName} t
    ${excludedVaultsJoin}
    WHERE t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
      ${excludedVaultsWhere}
  `;
}

function buildInsertQuery(spec: ArchiveTableSpec, retentionDays: number): string {
  const archiveTable = `${spec.tableName}_archive`;
  const excludedVaultsJoin = `
    LEFT JOIN vaults v ON v.${spec.vaultJoinColumn} = t.${spec.vaultJoinColumn}
  `;
  const excludedVaultsWhere = `AND (v.exclude_from_archive IS NULL OR v.exclude_from_archive = FALSE)`;

  return `
    INSERT INTO ${archiveTable}
    SELECT t.*
    FROM ${spec.tableName} t
    ${excludedVaultsJoin}
    WHERE t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
      ${excludedVaultsWhere}
  `;
}

function buildDeleteQuery(spec: ArchiveTableSpec, retentionDays: number): string {
  const excludedVaultsJoin = `
    LEFT JOIN vaults v ON v.${spec.vaultJoinColumn} = t.${spec.vaultJoinColumn}
  `;
  const excludedVaultsWhere = `AND (v.exclude_from_archive IS NULL OR v.exclude_from_archive = FALSE)`;

  return `
    DELETE FROM ${spec.tableName} t
    USING vaults v
    WHERE v.${spec.vaultJoinColumn} = t.${spec.vaultJoinColumn}
      AND t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
      ${excludedVaultsWhere}
  `;
}

function buildDeleteQuerySimple(spec: ArchiveTableSpec, retentionDays: number): string {
  if (spec.vaultJoinColumn === "contract_id") {
    return `
      DELETE FROM ${spec.tableName} t
      WHERE t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM vaults v
          WHERE v.${spec.vaultJoinColumn} = t.${spec.vaultJoinColumn}
            AND v.exclude_from_archive = TRUE
        )
    `;
  }

  return `
    DELETE FROM ${spec.tableName} t
    WHERE t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
      AND NOT EXISTS (
        SELECT 1 FROM vaults v
        WHERE v.${spec.vaultJoinColumn} = t.${spec.vaultJoinColumn}
          AND v.exclude_from_archive = TRUE
      )
  `;
}

export interface ArchiveResult {
  table: string;
  preArchivalCount: number;
  archivedCount: number;
  dryRun: boolean;
}

export async function runArchival(): Promise<ArchiveResult[]> {
  const dryRun = config.dryRun;
  const results: ArchiveResult[] = [];

  if (dryRun) {
    logger.info("Archival job running in DRY-RUN mode");
  }

  for (const spec of ARCHIVE_TABLES) {
    const retentionDays = getRetentionDays(spec);

    const countRows = await query<{ count: string }>(
      buildCountQuery(spec, retentionDays),
    );
    const preArchivalCount = parseInt(countRows[0]?.count ?? "0", 10);

    if (preArchivalCount === 0) {
      logger.info({ table: spec.tableName }, "No rows to archive");
      results.push({
        table: spec.tableName,
        preArchivalCount: 0,
        archivedCount: 0,
        dryRun,
      });
      continue;
    }

    if (dryRun) {
      logger.info(
        { table: spec.tableName, rowsToArchive: preArchivalCount, retentionDays },
        `Would archive ${preArchivalCount} rows from ${spec.tableName}`,
      );
      await query(
        `INSERT INTO archive_audit_log (table_name, pre_archival_count, archived_count, dry_run)
         VALUES ($1, $2, 0, TRUE)`,
        [spec.tableName, preArchivalCount],
      );
      results.push({
        table: spec.tableName,
        preArchivalCount,
        archivedCount: 0,
        dryRun: true,
      });
      continue;
    }

    await ensureArchiveTable(spec.tableName);

    const insertResult = await query<{ count: string }>(
      `${buildInsertQuery(spec, retentionDays)} RETURNING 1`,
    );
    const archivedCount = insertResult.length;

    await query(
      buildDeleteQuerySimple(spec, retentionDays),
    );

    await query(
      `INSERT INTO archive_audit_log (table_name, pre_archival_count, archived_count, dry_run)
       VALUES ($1, $2, $3, FALSE)`,
      [spec.tableName, preArchivalCount, archivedCount],
    );

    logger.info(
      { table: spec.tableName, archivedCount, retentionDays },
      `Archived ${archivedCount} rows from ${spec.tableName}`,
    );

    results.push({
      table: spec.tableName,
      preArchivalCount,
      archivedCount,
      dryRun: false,
    });
  }

  if (dryRun) {
    logger.info("Archival dry-run complete");
  } else {
    logger.info("Archival job complete");
  }

  return results;
}
