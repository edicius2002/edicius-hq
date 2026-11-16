import path from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../../vite.config';

describe('Vite environment', () => {
  it('loads the repository root environment used by the other scripts', () => {
    expect(config.envDir).toBe(path.resolve(process.cwd(), '../..'));
  });
});
