/** METARR_DRY_RUN=1 makes remux and file tagging report what they would change without writing to media. */
export function dryRun(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.METARR_DRY_RUN ?? "").trim());
}
