import { ConfigService } from './config/index.js';
import { ApplicationApi } from './api/index.js';
import { UIServer } from './ui/server.js';
import { Logger } from './common/logger.js';
import type { FirstRunReport } from './config/firstRunHealthCheck.js';
import type { CheckStatus } from './config/firstRunHealthCheck.js';

function checkIcon(status: CheckStatus): string {
  switch (status) {
    case 'OK': return 'OK  ';
    case 'DEGRADED': return 'WARN';
    case 'FAIL': return 'FAIL';
    case 'SKIP': return 'SKIP';
  }
}

function printFirstRunReport(report: FirstRunReport): void {
  console.log('\n====================================================');
  console.log(' NEXUS AI — SYSTEM HEALTH CHECK');
  console.log('====================================================');

  for (const check of report.checks) {
    const icon = checkIcon(check.status);
    const detail = check.detail ? `  ${check.detail}` : '';
    console.log(`  [${icon}]  ${check.name}${detail}`);
    if ((check.status === 'FAIL' || check.status === 'DEGRADED') && check.action) {
      console.log(`         Action: ${check.action}`);
    }
  }

  console.log('');
  const stateLabel = report.state;
  const isReady = stateLabel === 'READY' || stateLabel === 'CONFIGURED' || stateLabel === 'FIRST_RUN';
  console.log(`System Status: ${stateLabel}${isReady ? '' : ' — some subsystems require attention'}`);
  console.log('====================================================\n');
}

async function main(): Promise<void> {
  console.log('====================================================');
  console.log(' NEXUS AI — Local-First Windows Workstation Shell  ');
  console.log('====================================================');

  const configService = new ConfigService();
  const config = configService.getConfig();
  const logger = new Logger('Main', config.logLevel);

  logger.info(`Bootstrapping application shell in [${config.environment}] mode`);

  const appApi = new ApplicationApi(config);
  let uiServer: UIServer | null = null;

  const shutdown = async (signal: string) => {
    logger.info(`Shutdown signal '${signal}' received. Closing subsystems cleanly...`);
    try {
      if (uiServer) {
        await uiServer.stop();
      }
      appApi.close();
    } catch (err) {
      logger.error(`Error during graceful shutdown: ${String(err)}`);
    }
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').then(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').then(() => process.exit(0));
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception detected', { error: err.message });
    shutdown('uncaughtException').then(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection detected', { reason: String(reason) });
    shutdown('unhandledRejection').then(() => process.exit(1));
  });

  await appApi.bootstrap();

  // Start Desktop UI Server
  uiServer = new UIServer(appApi, config.port, config.logLevel);
  const listeningPort = await uiServer.start();
  console.log(`\n💻 NEXUS Desktop UI is live at: http://127.0.0.1:${listeningPort}`);

  // First-run health check with formatted diagnostics
  try {
    const report = await appApi.getFirstRunReport();
    if (report) {
      printFirstRunReport(report);
    }
  } catch (err) {
    logger.warn(`First-run health check failed: ${String(err)}. Falling back to raw status.`);
    const health = appApi.getHealthReport();
    console.log(`\n[Status] System Overall Health: ${health.overall.toUpperCase()}`);
    console.log('[Status] Subsystem Status Breakdown:');
    for (const subsystem of health.subsystems) {
      console.log(`  - ${subsystem.name}: [${subsystem.status.toUpperCase()}] ${subsystem.message}`);
    }
  }

  // Smoke test if Ollama is available
  const intelStatus = appApi.intelligence.getStatus();
  if (intelStatus?.details?.ollamaAvailable) {
    console.log('[RAG Smoke Test] Ingesting test document into default knowledge collection...');
    const defaultCol = appApi.knowledge.rag.getOrCreateDefaultCollection();

    const sampleDocText =
      '# NEXUS AI Architecture Overview\n' +
      'The NEXUS AI Orchestrator connects local language models, vector knowledge search, and permission-controlled tools.\n' +
      'All processing runs offline on the user device.';

    const ingestedDoc = await appApi.knowledge.rag.ingestText(
      'nexus_architecture_overview.md',
      sampleDocText,
      defaultCol.id
    );

    console.log(`[RAG Smoke Test] Ingested document '${ingestedDoc.filename}' (ID: ${ingestedDoc.id}, Version: ${ingestedDoc.currentVersion})`);
  } else {
    console.log('[Smoke Test Skipped] Ollama service is offline.');
  }

  console.log('\n[NEXUS AI] Phase P7-D Desktop UI/UX Station Active.');

  // Standalone startup stays alive or closes cleanly depending on process context
  if (process.env.NODE_ENV === 'test') {
    await uiServer.stop();
    appApi.close();
  }
}

main().catch((err) => {
  console.error('[NEXUS AI] Fatal Startup Error:', err);
  process.exit(1);
});
