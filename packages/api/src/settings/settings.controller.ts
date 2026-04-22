import { Controller, Get, Put, Body } from '@nestjs/common';
import { UserModel } from '@job-agent/shared';

// Global settings — one user, one document. These are master toggles that the
// pipeline reads at spawn time (not per-request), so flipping one here applies
// to every future auto-apply run until flipped back.

interface Settings {
  allowAutoSubmit: boolean;
}

const DEFAULTS: Settings = {
  allowAutoSubmit: false,
};

async function getSettingsFromDb(): Promise<Settings> {
  const user = await UserModel.findOne().lean();
  const s = (user as any)?.settings ?? {};
  return { ...DEFAULTS, ...s };
}

@Controller('settings')
export class SettingsController {
  @Get()
  async get(): Promise<Settings> {
    return getSettingsFromDb();
  }

  @Put()
  async put(@Body() body: Partial<Settings>): Promise<Settings> {
    const user = await UserModel.findOne();
    if (!user) throw new Error('No user document — set up profile first');
    const current = ((user as any).settings ?? {}) as Partial<Settings>;
    (user as any).settings = { ...DEFAULTS, ...current, ...body };
    await user.save();
    return (user as any).settings;
  }
}
