// The app's own path lists for `write-rate-limit.ts`. The limiter is shared
// with downstream apps; these lists name this app's modules, so they live
// apart and each app keeps its own.

/**
 * Bulk surfaces: one human gesture there is not one request. An attachment
 * picker uploads a whole selection, and a backup import or export moves the
 * whole database. These routes are bounded by `MAX_UPLOAD_BYTES`,
 * `UPLOADS_TOTAL_BYTES` and `MAX_ATTACHMENTS_PER_RESOURCE` — a byte quota, not
 * a frequency counter, is their primary defence — so they draw on a much
 * larger budget. Any path containing `/attachments` is bulk as well.
 */
export const BULK_PREFIXES: readonly string[] = ["/backup"];
export const BULK_SUFFIXES: readonly string[] = [];

/**
 * Content creation: a `POST` landing on one of these collection paths mints a
 * new record (and its audit row). Concrete request paths are matched, so one
 * suffix covers every parameterised mount — `/comments` catches the shared
 * `${prefix}/:id/comments` mount of every item sub-type.
 *
 * An endpoint missing from this list falls into the general write bucket, so
 * an omission is looser, never broken.
 */
export const CREATE_SUFFIXES: readonly string[] = [
  "/issues",
  "/documents",
  "/comments",
];
