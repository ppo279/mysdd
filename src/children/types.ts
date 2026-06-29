/**
 * Service-layer projection types for the Children module.
 *
 * Mirrors the `ProblemView` / `SolutionView` pattern in
 * `ProblemsService`: the Prisma row is a richer type (with `userId`,
 * with relations, with timestamps as `Date` etc.), but the API
 * response deliberately omits `userId` (always equals the JWT's
 * `userId`, so it's redundant + a small IDOR-shrink) and only carries
 * the four fields the client renders.
 *
 * `ChildView` is 1:1 with the `Child` Prisma model minus `userId`.
 * `ListChildrenResult` is the pagination envelope shape — `items`
 * carries the page rows, `total` is the user-scoped row count, and
 * `page` / `pageSize` echo back the request (so a client using the
 * envelope can render "showing 1-20 of 47" without re-reading the URL).
 *
 * Kept in a separate file (not inside the service) so both the
 * controller and the e2e tests can `import type` from the same
 * source — making the contract a single point of truth.
 */
export interface ChildView {
  id: number;
  name: string;
  grade: number;
  createTime: Date;
}

export interface ListChildrenResult {
  items: ChildView[];
  total: number;
  page: number;
  pageSize: number;
}
