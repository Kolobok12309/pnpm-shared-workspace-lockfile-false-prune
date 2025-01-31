import { mkdir, readdir, cp, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

import Debug from 'debug';
import { findWorkspaceDir } from '@pnpm/find-workspace-dir';
import {
  findWorkspacePackages,
  type Project,
} from '@pnpm/find-workspace-packages';

interface WorkspaceDependency {
  project: Project;
  dependencies: WorkspaceDependency[];
  injected: boolean;
}

export interface PnpmPrunerOptions {
  workspace: string;
  cwd?: string;
}

export class PnpmPruner {
  workspace: string;
  cwd: string;

  private debug = Debug('pnpm-shared-workspace-lockfile-false-prune');

  private packages: Project[] = [];
  private targetPackage: Project | null = null;
  private rootPackage: Project | null = null;
  private dependencyTree: WorkspaceDependency | null = null;
  private dependenciesList: Project[] = [];

  constructor(options: PnpmPrunerOptions) {
    ({ workspace: this.workspace, cwd: this.cwd = process.cwd() } = options);
  }

  async init() {
    this.debug(`Init pruner for "${this.workspace}" workspace`);

    const root = await findWorkspaceDir(this.cwd);

    if (!root)
      throw new Error(
        `[pnpm-shared-workspace-lockfile-false-prune] Monorepo root not found`,
      );

    this.debug(`Found monorepo root in "${root}"`);

    this.packages = await findWorkspacePackages(root);
    const targetPackage = this.packages.find(
      ({ manifest }) => manifest.name === this.workspace,
    );
    const rootPackage = this.packages.find(({ dir }) => dir === root);

    if (!targetPackage)
      throw new Error(
        `[pnpm-shared-workspace-lockfile-false-prune] Target workspace not found`,
      );
    if (!rootPackage)
      throw new Error(
        `[pnpm-shared-workspace-lockfile-false-prune] Monorepo manifest not found`,
      );

    this.targetPackage = targetPackage;
    this.rootPackage = rootPackage;
    this.debug(`Found target workspace in "${targetPackage.dir}"`);

    this.dependencyTree = this.getDependenciesTree(
      targetPackage,
      this.packages,
    );
    this.dependenciesList = this.dependenciesTreeToList(this.dependencyTree);

    this.debug(
      `Found dependency packages: ${this.dependenciesList.map(({ manifest }) => manifest.name)}`,
    );
  }

  async prune(out: string) {
    if (
      !this.packages ||
      !this.rootPackage ||
      !this.targetPackage ||
      !this.dependencyTree ||
      !this.dependenciesList
    )
      throw new Error(
        '[pnpm-shared-workspace-lockfile-false-prune] Pruner not initialized',
      );

    this.debug(
      `Run prune for ${this.workspace} from cwd ${this.cwd} with out ${out}`,
    );

    const outFolder = resolve(this.cwd, out);
    const outJsonFolder = resolve(outFolder, 'json');
    const outFullFolder = resolve(outFolder, 'full');

    try {
      this.debug(`Delete prev "${out}" folder if exists`);
      await rm(outFolder, {
        recursive: true,
      });
    } catch (err) {
      // @ts-expect-error
      if (err.code !== 'ENOENT') throw err;
    }

    this.debug(`Create out "${out}" folder`);
    await mkdir(outFolder);

    this.debug(`Create ${out}/json folder`);
    await mkdir(outJsonFolder);

    this.debug(`Create ${out}/full folder`);
    await mkdir(outFullFolder);

    this.debug('Copy shallow files');
    await Promise.all([
      this.copyJsonProject(outJsonFolder, this.rootPackage),
      this.copyFullProject(outFullFolder, this.rootPackage, [
        ...this.fullBlackList,
        out,
      ]),
      ...this.dependenciesList
        .concat(this.targetPackage)
        .map(async (project) => {
          const srcPath = project.dir;
          const relativePath = relative(this.cwd, srcPath);

          const outJsonPath = resolve(outJsonFolder, relativePath);
          const outFullPath = resolve(outFullFolder, relativePath);

          await Promise.all([
            this.copyJsonProject(outJsonPath, project),
            this.copyFullProject(outFullPath, project),
          ]);
        }),
    ]);

    this.debug('Project successfully pruned');
  }

  async postPrune(fullInjected: boolean) {
    if (
      !this.packages ||
      !this.rootPackage ||
      !this.targetPackage ||
      !this.dependencyTree ||
      !this.dependenciesList
    )
      throw new Error(
        '[pnpm-shared-workspace-lockfile-false-prune] Pruner not initialized',
      );

    this.debug('Start copy nested dependencies', fullInjected);
    // Необходимо чтобы для full-project докопировать все файлы
    // В случае symlink они и так появятся, в случае с hardlink (injected)
    // их необходимо принудительно проставлять
    const handleTreeInjected = async (
      tree: WorkspaceDependency,
      folder = tree.project.dir,
    ): Promise<void> => {
      this.debug(
        `Fill dependencies of ${tree.project.manifest.name} in ${folder}`,
      );

      await tree.dependencies.reduce(async (acc, subTree) => {
        await acc;
        const targetFolder = resolve(
          folder,
          'node_modules',
          subTree.project.manifest.name!,
        );

        if (subTree.injected) {
          await this.copyFullProject(targetFolder, subTree.project);
        }

        await handleTreeInjected(subTree, targetFolder);
      }, Promise.resolve());
    };

    await Promise.all([
      handleTreeInjected(this.dependencyTree),
      ...(fullInjected
        ? this.dependencyTree.dependencies.map((dep) => handleTreeInjected(dep))
        : []),
    ]);
  }

  getDependenciesTree(
    targetProject: Project,
    allPackages: Project[],
  ): WorkspaceDependency {
    const alreadyChecked = new WeakMap<Project, WorkspaceDependency[]>();

    const _getDependenciesTrees = (
      project: Project,
      parents: Project[] = [],
    ): WorkspaceDependency[] => {
      if (parents.includes(project)) {
        console.warn(
          'Recursion',
          parents.map(({ manifest }) => manifest.name),
        );
        return [];
      }
      if (alreadyChecked.has(project)) return alreadyChecked.get(project)!;

      this.debug(`Check dependencies of ${project.manifest.name}`);
      const {
        dependencies = {},
        devDependencies = {},
        peerDependencies = {},
        dependenciesMeta = {},
      } = project.manifest;

      const checkDependencies = (
        deps:
          | Project['manifest']['dependencies']
          | Project['manifest']['devDependencies']
          | Project['manifest']['peerDependencies'],
      ): WorkspaceDependency[] => {
        const derivedDependencies = [] as WorkspaceDependency[];

        Object.entries(deps!).forEach(([name, version]) => {
          if (version.startsWith('workspace:')) {
            const dependencyPackage = allPackages.find(
              ({ manifest }) => manifest.name === name,
            );

            if (!dependencyPackage) {
              console.warn(
                `[pnpm-prune] Not found package "name" from "${project.manifest.name}" manifest`,
              );
              return;
            }

            const injected = dependenciesMeta[name]?.injected ?? false;

            this.debug(
              `Found${injected ? ' injected' : ''} "${name}" in "${project.manifest.name}"`,
            );

            derivedDependencies.push({
              project: dependencyPackage,
              injected,
              dependencies: _getDependenciesTrees(dependencyPackage, [
                ...parents,
                project,
              ]),
            });
          }
        });

        return derivedDependencies;
      };

      return [
        ...checkDependencies(dependencies),
        ...checkDependencies(devDependencies),
        ...checkDependencies(peerDependencies),
      ];
    };

    return {
      project: targetProject,
      injected: false,
      dependencies: _getDependenciesTrees(targetProject),
    };
  }

  dependenciesTreeToList(tree: WorkspaceDependency): Project[] {
    const res = [] as Project[];

    const _dependenciesTreeToList = (subTree: WorkspaceDependency) => {
      if (res.includes(subTree.project)) return;

      res.push(subTree.project);
      subTree.dependencies.forEach(_dependenciesTreeToList);
    };
    tree.dependencies.forEach(_dependenciesTreeToList);

    return res;
  }

  checkProjectDependencies(
    targetProject: Project,
    allPackages: Project[],
  ): Project[] {
    const alreadyChecked = new WeakSet<Project>();
    const dependencyWorkspaces = new Set<Project>();

    const _checkProjectDependencies = (project: Project) => {
      if (alreadyChecked.has(project)) return;

      this.debug(`Check dependencies of ${project.manifest.name}`);
      alreadyChecked.add(project);
      const {
        dependencies = {},
        devDependencies = {},
        peerDependencies = {},
      } = project.manifest;

      const checkDependencies = (
        deps:
          | Project['manifest']['dependencies']
          | Project['manifest']['devDependencies']
          | Project['manifest']['peerDependencies'],
      ) => {
        Object.entries(deps!).forEach(([name, version]) => {
          if (version.startsWith('workspace:')) {
            const dependencyPackage = allPackages.find(
              ({ manifest }) => manifest.name === name,
            );

            if (!dependencyPackage) {
              console.warn(
                `[pnpm-prune] Not found package "name" from "${project.manifest.name}" manifest`,
              );
              return;
            }

            this.debug(`Found "${name}" in "${project.manifest.name}"`);

            dependencyWorkspaces.add(dependencyPackage);
            _checkProjectDependencies(dependencyPackage);
          }
        });
      };

      checkDependencies(dependencies);
      checkDependencies(devDependencies);
      checkDependencies(peerDependencies);
    };

    _checkProjectDependencies(targetProject);

    return [...dependencyWorkspaces];
  }

  jsonWhiteList = [
    'package.json',
    'pnpm-lock.yaml',
    '.npmrc',
    'pnpm-workspace.yaml',
    '.pnpmfile.cjs',
  ];

  async copyFromProjectToFolder(
    project: Project,
    outFolder: string,
    relativePath: string,
  ) {
    const srcPath = resolve(project.dir, relativePath);
    const outPath = resolve(outFolder, relativePath);

    try {
      await cp(srcPath, outPath, { recursive: true });
    } catch (err) {
      // @ts-expect-error
      if (err.code === 'ERR_FS_CP_EINVAL') return;

      throw err;
    }
  }

  async copyJsonProject(outFolder: string, project: Project): Promise<void> {
    this.debug(
      `Create json folder for "${project.manifest.name}" in "${outFolder}"`,
    );
    await mkdir(outFolder, { recursive: true });

    const dirScan = await readdir(project.dir);

    await Promise.all(
      dirScan.map(async (path) => {
        if (!this.jsonWhiteList.includes(path)) return;

        this.copyFromProjectToFolder(project, outFolder, path);
      }),
    );
    await Promise.all(
      Object.entries(project.manifest.bin || {}).map(
        async ([binName, path]) => {
          this.debug(`Move bin "${binName}" from "${project.manifest.name}"`);

          this.copyFromProjectToFolder(project, outFolder, path);
        },
      ),
    );
  }

  fullBlackList = ['node_modules', '.turbo', 'packages', 'apps'];

  async copyFullProject(
    outFolder: string,
    project: Project,
    blackList = this.fullBlackList,
  ): Promise<void> {
    this.debug(
      `Create full folder for "${project.manifest.name}" in "${outFolder}"`,
    );
    await mkdir(outFolder, { recursive: true });

    const dirScan = await readdir(project.dir);

    await Promise.all(
      dirScan.map(async (path) => {
        if (blackList.includes(path)) return;

        await this.copyFromProjectToFolder(project, outFolder, path);
      }),
    );
  }
}
