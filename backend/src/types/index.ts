export type VaultState =
  | "Funding"
  | "Active"
  | "Matured"
  | "Closed"
  | "Cancelled";

export interface Vault {
  id: number;
  contractId: string;
  factoryId: string | null;
  asset: string;
  name: string | null;
  symbol: string | null;
  state: VaultState;
  totalAssets: string;
  totalSupply: string;
  totalSharesEverMinted: string;
  totalSharesEverBurned: string;
  depositorCount: number;
  fundingTarget: string | null;
  fundingDeadline: Date | null;
  fundingProgress: number | null;
  minDeposit: string | null;
  maxDepositPerUser: string | null;
  zkmeVerifier: string | null;
  rwaName: string | null;
  rwaSymbol: string | null;
  rwaDocumentUri: string | null;
  rwaCategory: string | null;
  description: string | null;
  logoUri: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultOperator {
  address: string;
  active: boolean;
  assignedAt: string;
}

export interface User {
  id: number;
  address: string;
  kycVerified: boolean;
  amlFlagged: boolean;
  amlFlaggedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserVaultPosition {
  id: number;
  userAddress: string;
  vaultId: number;
  contractId?: string;
  state?: VaultState;
  shares: string;
  deposited: string;
  lastClaimedEpoch: number;
  updatedAt: Date;
}

export interface VaultHolder {
  userAddress: string;
  shares: string;
  deposited: string;
  lastUpdatedAt: Date;
}

export type VaultHolderSort = "shares" | "deposited";

export interface ShareBalanceHistoryEntry {
  epoch: number;
  shares: string;
  recordedAt: Date;
}

export interface RedemptionRequest {
  id: number;
  vaultId: number;
  userAddress: string;
  shares: string;
  requestTime: Date;
  processed: boolean;
  createdAt: Date;
}

export interface UserPortfolioResponse {
  positions: UserVaultPosition[];
  totalDeposited: string;
  totalPendingYield: string;
  totalValue: string;
}

export interface Epoch {
  id: number;
  vaultId: number;
  epoch: number;
  yieldAmount: string;
  totalShares: string;
  distributedAt: Date | null;
  netYield: string;
}

export interface IndexedEvent {
  id: number;
  ledger: number;
  txHash: string;
  contractId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  nextCursor?: string | null;
}

export interface YieldHistoryEntry {
  vaultContractId: string;
  epoch: number | null;
  amount: string;
  timestamp: string;
  eventType: string;
}

export interface KycHistoryEntry {
  vaultContractId: string;
  verified: boolean;
  ledger: number;
  timestamp: string;
}

export interface OperatorLogEntry {
  operatorAddress: string;
  action: "added" | "removed";
  callerAddress: string;
  ledger: number;
  timestamp: string;
}

export interface PortfolioPnlPosition {
  contractId: string;
  deposited: string;
  currentValue: string;
  gainLoss: string;
  gainLossPercent: number;
}

export interface PortfolioPnlResponse {
  positions: PortfolioPnlPosition[];
}

export interface IncomeForecastMonth {
  month: string;
  projectedYield: string;
  vaultCount: number;
}

export interface IncomeForecastResponse {
  months: IncomeForecastMonth[];
}

export interface AnalyticsSummary {
  totalUsers: number;
  totalVaults: number;
  totalValueLocked: string;
  totalYieldDistributed: string;
  totalDepositors: number;
}

export interface TvlAggregate {
  totalValueLocked: string;
  activeVaultCount: number;
  fundingVaultCount: number;
}

export interface PortfolioAllocation {
  category: string;
  deposited: string;
  percentage: number;
}

export interface PortfolioAllocationResponse {
  allocations: PortfolioAllocation[];
}

export interface PortfolioDiversification {
  score: number;
  vaultCount: number;
  categoryCount: number;
  herfindahlIndex: number;
}
