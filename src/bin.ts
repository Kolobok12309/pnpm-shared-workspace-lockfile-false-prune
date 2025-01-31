import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { PnpmPruner } from './pruner';

yargs(hideBin(process.argv))
  .command(
    'prune',
    'Analog on Turbo prune, but for shared-workspace-lockfile=false',
    (yargs) =>
      yargs
        .option('workspace', {
          description: 'Workspace that will be pruned',
          type: 'string',
        })
        .demandOption('workspace')
        .option('out', {
          description: 'Out folder',
          type: 'string',
          default: 'out',
        }),
    async (args) => {
      const pruner = new PnpmPruner({
        workspace: args.workspace,
      });

      await pruner.init();
      await pruner.prune(args.out);
    },
  )
  .command(
    'post-prune',
    'Analog on Turbo prune, but for shared-workspace-lockfile=false',
    (yargs) =>
      yargs
        .option('workspace', {
          description: 'Workspace that will be pruned',
          type: 'string',
        })
        .option('full-injected', {
          description: 'Fill dependencies not in workspace with injected deps',
          default: false,
          type: 'boolean',
        }),
    async (args) => {
      const pruner = new PnpmPruner({
        workspace: args.workspace!,
      });

      await pruner.init();
      await pruner.postPrune(args['full-injected']);
    },
  )
  .help().argv;
