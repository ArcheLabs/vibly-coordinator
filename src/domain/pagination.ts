/** Slice a list using limit/offset style paging (used by projection-backed list endpoints). */
export function paginateList<T>(items: T[], limit: number, offset = 0): T[] {
  return items.slice(offset, offset + limit);
}
