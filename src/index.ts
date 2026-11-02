import { loadConfig } from './config.js';
import { migrate, openDb } from './db/index.js';
import { Registry } from './catalog/registry.js';
import { buildApp, createServices } from './http/app.js';

async function main() {
  const config = loadConfig();
  const db = await openDb(config.DATABASE_URL);
  await migrate(db);
  const registry = Registry.default();
  const services = createServices(config, db, registry);
  const app = await buildApp(services);

  const toolCount = registry.listToolkits().reduce((n, tk) => n + tk.tools.length, 0);
  app.log.info({ toolkits: registry.listToolkits().length, tools: toolCount }, 'catalog loaded');
  const providers = Object.keys(config.platformOAuthApps);
  app.log.info(
    { providers },
    providers.length
      ? 'platform OAuth apps configured'
      : 'no platform OAuth apps configured (tenants must bring their own)',
  );

  let sweep: NodeJS.Timeout | undefined;
  if (config.REFRESH_SWEEP_SECONDS > 0) {
    sweep = setInterval(async () => {
      try {
        const r = await services.connections.sweepExpiring();
        if (r.refreshed || r.failed) app.log.info(r, 'token refresh sweep');
      } catch (e) {
        app.log.error(e, 'token refresh sweep failed');
      }
    }, config.REFRESH_SWEEP_SECONDS * 1000);
    sweep.unref();
  }

  let triggerTimer: NodeJS.Timeout | undefined;
  if (config.TRIGGER_TICK_SECONDS > 0) {
    let running = false;
    triggerTimer = setInterval(async () => {
      if (running) return; // never overlap passes in one process; other replicas coordinate through row leases
      running = true;
      try {
        const r = await services.triggers.tick();
        if (r.polled || r.delivered || r.renewed) app.log.debug(r, 'trigger pass');
      } catch (e) {
        app.log.error(e, 'trigger pass failed');
      } finally {
        running = false;
      }
    }, config.TRIGGER_TICK_SECONDS * 1000);
    triggerTimer.unref();
  }

  const shutdown = async () => {
    clearInterval(sweep);
    clearInterval(triggerTimer);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
