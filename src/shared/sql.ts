export type Statement = {
  sql: string
  //   bindings?: any[]
}

/**
 * SQL tag.
 *
 * When used as a template tag, multiple SQL statements are accepted and
 * string interpolants can be used, e.g.
 * ```
 *   const statement = sql`
 *     PRAGMA integrity_check;
 *     SELECT * FROM ${tblName};
 *   `;
 * ```
 */
export const sql = (sql: TemplateStringsArray, ...values: any[]): Statement => {
  const interleaved: any[] = []
  sql.forEach((s, i) => {
    interleaved.push(s, values[i])
  })
  return { sql: interleaved.join("") }
}
