import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackupPublicationUnknownError } from '../../src/ops/backup.js';
import {
  parseMaintenanceConfig, runMaintenance, runMaintenanceFromConfig,
  type MaintenanceConfig, type MaintenanceDependencies,
} from '../../src/ops/maintenance.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ config: MaintenanceConfig; order: string[]; dependencies: MaintenanceDependencies }> {
  const root = await mkdtemp(join(tmpdir(), 'ocpa-maintenance-'));
  roots.push(root);
  const stateDir = join(root, 'state');
  const restoreRoot = join(root, 'restore');
  const workspaceDir = join(root, 'workspace');
  const backupDir = join(root, 'backups');
  await Promise.all([stateDir, restoreRoot, workspaceDir, backupDir].map(path => mkdir(path)));
  const order: string[] = [];
  const archivePath = join(backupDir, '2026-08-27.age');
  const manifest = { version: 1, createdAt: '2026-08-27T03:00:00.000Z', gitHead: 'a'.repeat(40) } as never;
  const health = {
    report: vi.fn(() => { order.push('health-report'); }),
    recover: vi.fn(() => { order.push('health-recover'); }),
    listActive: vi.fn(() => []), close: vi.fn(() => { order.push('health-close'); }),
  };
  return {
    config: {
      version: 1, workspaceDir, stateDir, backupDir, restoreRoot,
      identityFile: join(root, 'offline', 'age-identity'), recipient: `age1${'q'.repeat(20)}`,
    },
    order,
    dependencies: {
      openHealth: () => health,
      openRepository: async () => ({ quiesce: async work => work(), close: () => { order.push('repository-close'); } }) as never,
      createBackup: vi.fn(async () => {
        order.push('create');
        return { archivePath, manifest, outboxEvidence: {} as never };
      }),
      verifyBackup: vi.fn(async input => {
        order.push('verify');
        return { archivePath: input.archivePath, manifest, outboxEvidence: {} as never };
      }),
      verifyScheduledRestore: vi.fn(async input => {
        order.push(input.kind === 'daily-sample' ? 'daily-restore' : 'monthly-restore');
        return { evidencePath: join(stateDir, 'backup-restore-verifications.jsonl'), manifest, restoreRetained: false };
      }),
      applyRetention: vi.fn(async () => {
        order.push('retention');
        return { deleted: [], retained: [archivePath] };
      }),
      now: () => new Date('2026-08-27T03:00:00.000Z'),
    },
  };
}

describe('maintenance orchestration', () => {
  it('accepts only a versioned non-secret config with an offline identity path', () => {
    const valid = {
      version: 1, workspaceDir: '/home/owner/.openclaw/workspace',
      stateDir: '/home/owner/.openclaw/state/openclaw-personal-assistant',
      backupDir: '/mnt/d/openclaw_setting/backups',
      restoreRoot: '/home/owner/.openclaw/state/openclaw-personal-assistant/maintenance-restores',
      identityFile: '/media/owner/offline/age-identity', recipient: `age1${'q'.repeat(20)}`,
    };
    expect(parseMaintenanceConfig(valid)).toEqual(valid);
    for (const identityFile of [
      '/mnt/d/offline/age-identity',
      '/home/owner/.openclaw/workspace/age-identity',
      '/absolute/offline/age-identity',
    ]) expect(() => parseMaintenanceConfig({ ...valid, identityFile })).toThrow();
    expect(() => parseMaintenanceConfig({ ...valid, identityValue: 'private', identityFile: valid.identityFile }))
      .toThrow();
  });

  it('fails before backup when the mounted identity cannot be securely validated', async () => {
    const run = vi.fn();
    const config: MaintenanceConfig = {
      version: 1, workspaceDir: '/home/owner/.openclaw/workspace',
      stateDir: '/home/owner/.openclaw/state/openclaw-personal-assistant',
      backupDir: '/mnt/d/openclaw_setting/backups',
      restoreRoot: '/home/owner/.openclaw/state/openclaw-personal-assistant/maintenance-restores',
      identityFile: '/media/owner/offline/age-identity', recipient: `age1${'q'.repeat(20)}`,
    };

    await expect(runMaintenanceFromConfig('daily', '/private/maintenance.json', {
      readConfig: async () => config,
      validateIdentity: async () => { throw new Error('media missing'); },
      run,
    })).rejects.toMatchObject({ code: 'maintenance_identity_unavailable' });

    expect(run).not.toHaveBeenCalled();
  });

  it('runs daily create, exact verify, isolated sample restore, then retention once', async () => {
    const f = await fixture();

    const result = await runMaintenance({ kind: 'daily', config: f.config, dependencies: f.dependencies });

    expect(result).toMatchObject({ status: 'open', kind: 'daily', deletedCount: 0 });
    expect(f.order).toEqual([
      'create', 'verify', 'daily-restore', 'health-recover', 'retention',
      'repository-close', 'health-close',
    ]);
    expect(f.dependencies.createBackup).toHaveBeenCalledTimes(1);
    expect(f.dependencies.verifyBackup).toHaveBeenCalledTimes(1);
    expect(f.dependencies.verifyScheduledRestore).toHaveBeenCalledTimes(1);
    expect(f.dependencies.applyRetention).toHaveBeenCalledTimes(1);
  });

  it('never restores or retains when publication outcome is unknown and closes durable health', async () => {
    const f = await fixture();
    f.dependencies.createBackup = vi.fn(async () => {
      f.order.push('create');
      throw new BackupPublicationUnknownError('backup-publication:test');
    });

    await expect(runMaintenance({ kind: 'daily', config: f.config, dependencies: f.dependencies }))
      .rejects.toMatchObject({ code: 'publication_unknown' });

    expect(f.dependencies.verifyScheduledRestore).not.toHaveBeenCalled();
    expect(f.dependencies.applyRetention).not.toHaveBeenCalled();
    expect(f.order).toEqual(['create', 'health-report', 'repository-close', 'health-close']);
  });

  it('blocks retention when health recovery fails after restore verification', async () => {
    const f = await fixture();
    const health = f.dependencies.openHealth(f.config);
    health.recover = () => { throw new Error('health unavailable'); };
    f.dependencies.openHealth = () => health;

    await expect(runMaintenance({ kind: 'daily', config: f.config, dependencies: f.dependencies }))
      .rejects.toMatchObject({ code: 'maintenance_health_failed' });

    expect(f.dependencies.applyRetention).not.toHaveBeenCalled();
  });

  it('records corrupt restore failure and retains nothing', async () => {
    const f = await fixture();
    f.dependencies.verifyScheduledRestore = vi.fn(async () => {
      f.order.push('daily-restore');
      throw new Error('manifest mismatch');
    });

    await expect(runMaintenance({ kind: 'daily', config: f.config, dependencies: f.dependencies }))
      .rejects.toMatchObject({ code: 'maintenance_failed' });

    expect(f.dependencies.applyRetention).not.toHaveBeenCalled();
    expect(f.order).toContain('health-report');
  });

  it('selects the exact newest archive for monthly full restore evidence without backup or retention', async () => {
    const f = await fixture();
    await writeFile(join(f.config.backupDir, '2026-08-26.age'), 'older');
    await writeFile(join(f.config.backupDir, '2026-08-27.age'), 'newest');

    const result = await runMaintenance({ kind: 'monthly', config: f.config, dependencies: f.dependencies });

    expect(result).toMatchObject({
      status: 'open', kind: 'monthly', archive: join(f.config.backupDir, '2026-08-27.age'), deletedCount: 0,
    });
    expect(f.dependencies.createBackup).not.toHaveBeenCalled();
    expect(f.dependencies.verifyBackup).toHaveBeenCalledWith(expect.objectContaining({
      archivePath: join(f.config.backupDir, '2026-08-27.age'),
    }));
    expect(f.order).toEqual(['verify', 'monthly-restore', 'health-recover', 'health-close']);
    expect(f.dependencies.applyRetention).not.toHaveBeenCalled();
  });

  it('allows only one concurrent run across provider instances', async () => {
    const f = await fixture();
    let release!: () => void;
    const entered = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    f.dependencies.createBackup = vi.fn(async () => {
      started();
      await entered;
      return {
        archivePath: join(f.config.backupDir, '2026-08-27.age'),
        manifest: { version: 1, gitHead: 'a'.repeat(40) } as never,
        outboxEvidence: {} as never,
      };
    });
    const first = runMaintenance({ kind: 'daily', config: f.config, dependencies: f.dependencies });
    await starting;

    await expect(runMaintenance({ kind: 'daily', config: f.config, dependencies: f.dependencies }))
      .rejects.toMatchObject({ code: 'maintenance_busy' });
    expect(f.dependencies.createBackup).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ status: 'open' });
  });
});
