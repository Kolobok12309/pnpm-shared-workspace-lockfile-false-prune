import { resolve } from 'node:path';
import { rm, mkdir, cp } from 'node:fs/promises';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';

import { it, describe, expect } from 'vitest';

import { PnpmPruner } from '../src';

const _execAsync = promisify(exec);
const execAsync = (...args: Parameters<typeof _execAsync>) =>
  _execAsync(...args).then((res) => {
    const { stderr, stdout } = res;

    if (stderr) {
      console.error(stderr);
      throw new Error('Exec error');
    }

    console.log(stdout);

    return res;
  });

describe.each(['common', 'hoists'])(
  'Check valid for "%s" monorepo',
  (fixtureName) => {
    const monorepoPath = resolve(__dirname, fixtureName);

    describe.each(['front', 'back'])('Check %s app', async (workspace) => {
      const outPath = resolve(monorepoPath, `out-${workspace}`);
      const outFullPath = resolve(outPath, 'full');
      const outJsonPath = resolve(outPath, 'json');

      const pruner = new PnpmPruner({
        workspace,
        cwd: monorepoPath,
      });

      it('Success run prune', async () => {
        await expect(
          (async () => {
            await pruner.init();
            await pruner.prune(outPath);
          })(),
        ).resolves.not.toThrow();
      });

      it('Check json folder', async () => {
        await expect(
          execAsync('pnpm install --frozen-lockfile', {
            cwd: outJsonPath,
          }),
          'Success pnpm install',
        ).resolves.not.toThrow();

        if (workspace === 'front') {
          await expect(
            execAsync('util-cli', {
              cwd: resolve(outJsonPath, `apps/${workspace}`),
            }),
            'Success run binary',
          ).resolves.not.toThrow();
        }
      });

      it('Check full folder', async () => {
        await expect(
          execAsync('pnpm install --frozen-lockfile', {
            cwd: outFullPath,
          }),
          'Success pnpm install',
        ).resolves.not.toThrow();

        await expect(
          execAsync(`node apps/${workspace}/index.js`, {
            cwd: outFullPath,
          }),
          'Success run app',
        ).resolves.not.toThrow();
      });

      it('Check full pipeline', async () => {
        await rm(outPath, { recursive: true });
        await pruner.prune(outPath);

        const tmpPath = outPath + '-tmp';

        try {
          await rm(tmpPath, { recursive: true });
        } catch (err) {
          // @ts-expect-error
          if (err.code !== 'ENOENT') throw err;
        }
        await mkdir(tmpPath, { recursive: true });
        await cp(outJsonPath, tmpPath, { recursive: true });

        await execAsync('pnpm install --frozen-lockfile', {
          cwd: tmpPath,
        });

        await cp(outFullPath, tmpPath, { recursive: true });

        const prunerForTmp = new PnpmPruner({
          workspace,
          cwd: tmpPath,
        });
        await prunerForTmp.init();
        await prunerForTmp.postPrune(false);

        if (workspace === 'front') {
          await execAsync('util-cli', {
            cwd: resolve(tmpPath, `apps/${workspace}`),
          });
        }
        await execAsync(`node apps/${workspace}/index.js`, {
          cwd: tmpPath,
        });
      });
    });
  },
);
