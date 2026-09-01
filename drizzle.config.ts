import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

const host = process.env.DB_HOST || 'localhost';
const port = Number(process.env.DB_PORT || '3306');
const user = process.env.DB_USER || 'root';
const password = process.env.DB_PASSWORD || '';
const database = process.env.DB_NAME || 'sao';

export default defineConfig({
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
  dialect: 'mysql',
  dbCredentials: {
    host,
    port,
    user,
    password,
    database,
    ssl: {
      rejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== 'false',
    },
  },
});
