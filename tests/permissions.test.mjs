// Run with PGlite 0.5.8 installed outside the site:
// PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js node tests/permissions.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
const db = new PGlite();
const migration = await fs.readFile(new URL('../sql/002_ticket_permissions.sql', import.meta.url), 'utf8');
await db.exec(`
  create role anon; create role authenticated;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
  $$ select (auth.jwt()->>'sub')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  create table members (id uuid primary key default gen_random_uuid(), name text not null unique,
    email text not null, created_at timestamptz not null default now(), is_admin boolean not null default false);
  create unique index member_email_test on members(lower(email));
  create table tickets (id bigint generated always as identity primary key, note text, seat text, status text);
  create table ticket_logs (id bigint generated always as identity primary key, operator text, action text, detail text, ticket_id bigint);
  grant select, insert, update, delete, truncate on all tables in schema public to anon, authenticated;
  grant usage, select on all sequences in schema public to anon, authenticated;
  alter table members enable row level security;
  alter table tickets enable row level security;
  alter table ticket_logs enable row level security;
  create policy members_public_read on members for select to public using(true);
  create policy members_self_insert on members for insert to authenticated with check(true);
  create policy auth_full_tickets on tickets for all to authenticated using(true) with check(true);
  create policy auth_full_logs on ticket_logs for all to authenticated using(true) with check(true);
  create policy anon_blocked on tickets for all to anon using(false);
  create policy anon_blocked on ticket_logs for all to anon using(false);
  insert into members(name,email,is_admin) values ('大瓜','admin@example.test',true), ('星黎','member@example.test',false);
  insert into tickets(note,seat,status) values ('[BY:大瓜]','A1','在手'),('[BY:星黎]','A2','在手'),(null,'A3','在手');
`);
await db.exec(migration);
await db.exec(migration); // Safe to rerun without stacking policies.
let checks = 0;
async function asUser(role, email) {
  await db.exec('reset role');
  const claims = email ? {sub: '00000000-0000-0000-0000-000000000001', email} : {};
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
}
async function count(sql, expected) {
  const {rows} = await db.query(sql);
  assert.equal(rows.length, expected, sql); checks++;
}
async function blocked(sql) {
  await assert.rejects(db.exec(sql)); checks++;
}
await asUser('anon');
await count('select * from tickets', 0);
await count('select * from ticket_logs', 0);
await blocked("insert into tickets(note) values('[BY:星黎]')");
await asUser('authenticated','outsider@example.test');
await count('select * from tickets', 0);
await blocked("insert into tickets(note) values('[BY:星黎]')");
await blocked("insert into ticket_logs(operator) values('星黎')");
await blocked("insert into members(name,email,is_admin) values('薯饼','outsider@example.test',true)");
await blocked("insert into members(name,email) values('薯饼','someone-else@example.test')");
await blocked("insert into members(name,email) values('任意新名字','outsider@example.test')");
await asUser('authenticated','member@example.test');
await count('select * from tickets', 3);
await count("update tickets set status='预定' where id=1 returning id",0);
await count('delete from tickets where id=1 returning id',0);
await count("update tickets set status='预定' where id=3 returning id",0);
await count("update tickets set status='预定' where id=2 returning id",1);
await blocked("insert into tickets(note) values('[BY:大瓜]')");
await blocked("insert into tickets(note) values('[BY:星黎][BY:大瓜]')");
await count("insert into tickets(note) values('[BY:星黎]') returning id",1);
await count("update tickets set note='[原属:星黎][BY:薯饼]' where id=2 returning id",1);
await count("update tickets set status='已出' where id=2 returning id",0);
await count("insert into ticket_logs(operator,action) values('星黎','转票') returning id",1);
await blocked("insert into ticket_logs(operator,action) values('大瓜','转票')");
await count("update ticket_logs set action='篡改' returning id",0);
await count('delete from ticket_logs returning id',0);
await blocked('truncate tickets');
await count('update members set is_admin=true returning id',0);
await asUser('authenticated','receiver@example.test');
await count("insert into members(name,email) values('薯饼','receiver@example.test') returning name",1);
await blocked("insert into members(name,email) values('村民','receiver@example.test')");
await count("update tickets set status='已出' where id=2 returning id",1);
await count("update tickets set note='[BY:星黎]' where id=2 returning id",1);
await asUser('authenticated','admin@example.test');
await count("update tickets set status='预定' returning id",4);
await count('delete from ticket_logs returning id',1);
await count('delete from tickets returning id',4);
await db.close();
console.log(`${checks} permission checks passed; migration applied twice. No production data accessed.`);
