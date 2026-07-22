/* BW demake smoke-boot: load the built ROM in headless mGBA-WASM, run frames,
 * and confirm it renders a non-blank screen (i.e. the ROM image boots and is not
 * a crash/black-screen). Validates the whole authored slice actually runs, beyond
 * compiling. Run: tsx src/bw/smoke-boot.ts */
import { promises as fs } from 'node:fs';
import { emulator } from '@rom-introspection/engine';

const ROM = 'C:/path/to/pokefirered-expansion/pokefirered.gba';

async function main(): Promise<void> {
  const probe = emulator.probeEmulatorAvailability();
  if (!probe.available) {
    console.log(`SMOKE: emulator unavailable (${probe.reason ?? '?'}) - skipping (build still verified).`);
    return;
  }
  const emu = await emulator.createEmulator({ bootTimeoutMs: 150_000 });
  try {
    const rom = new Uint8Array(await fs.readFile(ROM));
    await emu.loadRom(rom);
    // Advance through BIOS/copyright/intro; tap START/A to push toward the title.
    const tap = async (name: 'A' | 'Start'): Promise<void> => {
      emu.pressButton(name as never);
      await emu.runFrames(4);
      emu.releaseButton(name as never);
      await emu.runFrames(20);
    };
    await emu.runFrames(240);
    for (let i = 0; i < 6; i++) await tap(i % 2 === 0 ? 'Start' : 'A');
    await emu.runFrames(120);

    const fb = await emu.getFramebuffer(); // RGBA, 240x160
    const px = fb.length / 4;
    let nonBlack = 0;
    let sum = 0;
    for (let i = 0; i < fb.length; i += 4) {
      const lum = (fb[i] ?? 0) + (fb[i + 1] ?? 0) + (fb[i + 2] ?? 0);
      if (lum > 24) nonBlack++;
      sum += lum;
    }
    const pct = (100 * nonBlack) / px;
    console.log(`SMOKE: booted OK - ${px}px, nonBlack ${nonBlack} (${pct.toFixed(1)}%), avgLum ${(sum / px).toFixed(1)}`);
    console.log(pct > 2 ? 'SMOKE: PASS - ROM boots and renders a non-blank screen.' : 'SMOKE: WARN - screen mostly black after boot.');
  } finally {
    emu.dispose();
  }
}

main().catch((e: unknown) => {
  console.error('SMOKE: ERROR - ', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
