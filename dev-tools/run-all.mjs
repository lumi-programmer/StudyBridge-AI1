// Runs every smoke section in order and prints the combined report.
// Reset the Node kernel before each run so edited harness modules reload.
import { sectionCore, sectionLibrary, sectionScan, sectionProviders, sectionLearn, sectionIsolation, sectionFailures, sectionTrial, sectionResilience, sectionLimits, sectionGemini, sectionAcceptance, sectionPhase2 } from './cases.mjs';

export async function runAll() {
  const lines = [];
  async function step(name, work) {
    try {
      const result = await work();
      lines.push(`\n== ${name} ==\n${result.report}` + (result.libReport ? `\n  (library within: ${result.libReport.split('\n')[0]})` : ''));
      return result;
    } catch (error) {
      lines.push(`\n== ${name} ==\n!! THREW: ${(error && error.stack) || String(error)}`);
      return null;
    }
  }

  await step('A core', () => sectionCore());
  const lib = await step('B library', () => sectionLibrary(null, {}));
  if (lib) await step('C scan', () => sectionScan(lib.env, lib.ids));
  await step('D providers', () => sectionProviders());
  await step('E learn', () => sectionLearn());
  await step('F isolation', () => sectionIsolation());
  await step('G failures', () => sectionFailures({ modelsStatus: 503, completeStatus: 503 }));
  await step('H free trial', () => sectionTrial());
  await step('I resilience', () => sectionResilience());
  await step('J limits', () => sectionLimits());
  await step('K gemini wire', () => sectionGemini());
  await step('L acceptance', () => sectionAcceptance());
  await step('M phase 2', () => sectionPhase2());

  return lines.join('\n');
}
