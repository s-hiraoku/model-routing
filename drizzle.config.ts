import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/datastore/src/schema.ts",
  out: "./packages/datastore/drizzle",
});
