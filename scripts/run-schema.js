#!/usr/bin/env node
// Kjører hele supabase/schema.sql direkte mot databasen, i én transaksjon
// (ruller alt tilbake om noe feiler underveis — ingen delvis endring).
//
// Krever SUPABASE_DB_URL i .env (IKKE committet — se .env.example).
// Hentes fra Supabase: prosjektet → "Connect"-knappen øverst → "URI" under
// Connection string → "Reveal"/"Reset database password" for passordet.
//
// Bruk:
//   npm run db:migrate
//
// Trygt å kjøre om igjen når som helst — schema.sql er skrevet for å alltid
// være idempotent (kun "add column if not exists" / "on conflict do
// nothing" / betingede migrasjoner), aldri destruktivt mot eksisterende data.

require("dotenv").config();
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

const SCHEMA_PATH = path.join(__dirname, "..", "supabase", "schema.sql");

(async () => {
  if (!process.env.SUPABASE_DB_URL) {
    console.error("Mangler SUPABASE_DB_URL i .env — se scripts/run-schema.js øverst for hvordan du finner den.");
    process.exit(1);
  }
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("commit");
    console.log("✓ supabase/schema.sql kjørt OK mot databasen.");
  } catch (err) {
    await client.query("rollback").catch(function () {});
    console.error("✗ Feilet, alt rullet tilbake (ingen delvis endring gjort):", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
