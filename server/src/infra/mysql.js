import mysql from "mysql2/promise";

export function createMysql(config) {
  let pool = null;

  function get() {
    if (!pool) {
      pool = mysql.createPool({
        host: config.mysql.host,
        port: config.mysql.port,
        user: config.mysql.user,
        password: config.mysql.password,
        database: config.mysql.database,
        waitForConnections: true,
        connectionLimit: config.mysql.connectionLimit,
        charset: "utf8mb4",
        dateStrings: true,
      });
    }
    return pool;
  }

  return {
    pool: get,
    async query(sql, params = []) {
      const [rows] = await get().query(sql, params);
      return rows;
    },
    async execute(sql, params = []) {
      const [result] = await get().execute(sql, params);
      return result;
    },
    /** 多语句按顺序执行，失败即中止（依赖调用方自己包事务）。 */
    async tx(fn) {
      const conn = await get().getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
      } catch (err) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw err;
      } finally {
        conn.release();
      }
    },
    async close() {
      if (pool) {
        try { await pool.end(); } catch { /* ignore */ }
        pool = null;
      }
    },
  };
}
