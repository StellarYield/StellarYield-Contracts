import type { Request, Response, NextFunction } from "express";
import { config } from "../../config.js";
import { logger } from "../../logger.js";

type WriteCallback = (error?: Error | null) => void;
type EndCallback = () => void;

export function responseSizeLimit(maxMb: number = config.maxResponseSizeMb) {
  const maxBytes = maxMb * 1024 * 1024;
  const warnBytes = maxBytes * 0.8;

  return (req: Request, res: Response, next: NextFunction): void => {
    let bytesWritten = 0;
    let warnLogged = false;
    let limitExceeded = false;
    let errorHandled = false;

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalSetHeader = res.setHeader.bind(res);

    function restoreRes() {
      res.write = originalWrite;
      res.end = originalEnd;
      res.setHeader = originalSetHeader;
    }

    function checkAndLogWarning(size: number) {
      if (size > warnBytes && !warnLogged) {
        warnLogged = true;
        logger.warn(
          { path: req.originalUrl || req.path, bytesWritten: size, maxBytes },
          "Response size approaching limit (>80% of max)",
        );
      }
    }

    function triggerErrorResponse() {
      if (errorHandled) return;
      errorHandled = true;
      restoreRes();

      logger.error(
        { path: req.originalUrl || req.path, bytesWritten, maxBytes },
        "Response size limit exceeded (>MAX_RESPONSE_SIZE_MB)",
      );

      if (!res.headersSent) {
        res.setHeader("Content-Type", "application/json");
        res.status(500).json({
          error: "InternalServerError",
          message: "Response size limit exceeded",
        });
      } else {
        res.destroy();
      }
    }

    res.setHeader = function (name: string, value: number | string | readonly string[]) {
      if (typeof name === "string" && name.toLowerCase() === "content-length") {
        const contentLength = parseInt(String(value), 10);
        if (!isNaN(contentLength)) {
          checkAndLogWarning(contentLength);
          if (contentLength > maxBytes && !limitExceeded) {
            limitExceeded = true;
          }
        }
      }
      return originalSetHeader(name, value);
    };

    res.write = function (
      chunk: unknown,
      encoding?: BufferEncoding | WriteCallback,
      callback?: WriteCallback,
    ): boolean {
      if (errorHandled) {
        return false;
      }

      if (limitExceeded) {
        triggerErrorResponse();
        return false;
      }

      if (chunk) {
        const len = Buffer.isBuffer(chunk)
          ? chunk.length
          : typeof chunk === "string"
            ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : "utf8")
            : 0;
        bytesWritten += len;
      }

      checkAndLogWarning(bytesWritten);

      if (bytesWritten > maxBytes) {
        limitExceeded = true;
        triggerErrorResponse();
        return false;
      }

      // Node takes either (chunk, callback) or (chunk, encoding, callback), so
      // forward whichever form was called. An omitted encoding is passed as
      // "utf8", the same default Node applies.
      return typeof encoding === "function"
        ? originalWrite(chunk, encoding)
        : originalWrite(chunk, encoding ?? "utf8", callback);
    };

    res.end = function (
      chunk?: unknown,
      encoding?: BufferEncoding | EndCallback,
      callback?: EndCallback,
    ): Response {
      if (errorHandled) {
        return res;
      }

      if (limitExceeded) {
        triggerErrorResponse();
        return res;
      }

      if (chunk) {
        const len = Buffer.isBuffer(chunk)
          ? chunk.length
          : typeof chunk === "string"
            ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : "utf8")
            : 0;
        bytesWritten += len;
      }

      checkAndLogWarning(bytesWritten);

      if (bytesWritten > maxBytes) {
        limitExceeded = true;
        triggerErrorResponse();
        return res;
      }

      return typeof encoding === "function"
        ? originalEnd(chunk, encoding)
        : originalEnd(chunk, encoding ?? "utf8", callback);
    };

    next();
  };
}
