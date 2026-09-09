# @taut/server

Effect + SQLite backend for Taut: HttpApi at `/api`, WebSocket event stream at `/ws`, static web client at `/`.

- Run (dev, tsx watch, :3000): `pnpm --filter @taut/server dev`
- Build and start: `pnpm --filter @taut/server build && pnpm --filter @taut/server start`
- Test / typecheck / lint: `pnpm --filter @taut/server test|typecheck|lint` (or from the root: `pnpm test`)
- Env (see `/.env.example`): `PORT` (3000), `TAUT_DATA_DIR` (./data), `TAUT_MASTER_KEY` (base64 32B; auto-generated in dev, required in production), `TAUT_COOKIE_SECURE` (= production), `TAUT_WEB_DIST` (../web/dist)
- Smoke: `curl localhost:3000/api/health` → `{"ok":true,"version":"0.0.0"}`; `websocat -H 'Cookie: taut_session=usr_dev:cmp_dev' ws://localhost:3000/ws?since=0`
- Layout: `src/config.ts` (all env), `src/db` (client, migrator, `migrations/NNNN_*.ts`), `src/realtime` (EventLog, Bus, ws), `src/http` (api groups, static, server), `src/vault/crypto.ts`, `src/layers.ts` (layer graph), `src/_placeholder` (stand-ins to be replaced by `@taut/contract` + real auth)
