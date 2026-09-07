import chalk from "chalk";
import ora from "ora";

export async function waitForMintTime(mintTime: Date, earlyFireMs: number = 0): Promise<void> {
  // Fire early by earlyFireMs — tx sits in mempool and lands the moment contract allows
  const fireTime = new Date(mintTime.getTime() - earlyFireMs);
  const now = new Date();
  const diff = fireTime.getTime() - now.getTime();

  if (diff <= 0) {
    console.log(chalk.yellow("  Fire time already passed — sending immediately."));
    return;
  }

  console.log(chalk.bold.white(`\n⏰ Mint time: ${mintTime.toISOString()}`));
  if (earlyFireMs > 0) {
    console.log(chalk.bold.yellow(`  🔥 Early fire: ${earlyFireMs}ms before mint → firing at ${fireTime.toISOString()}`));
  }
  console.log(chalk.gray(`  Now: ${now.toISOString()} | Waiting ${Math.ceil(diff / 1000)}s...\n`));

  // If more than 10 seconds away, show a countdown spinner
  if (diff > 10000) {
    const spinner = ora({
      text: formatCountdown(fireTime),
      color: "cyan",
    }).start();

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const remaining = fireTime.getTime() - Date.now();

        if (remaining <= 5000) {
          clearInterval(interval);
          spinner.stop();
          resolve();
        } else {
          spinner.text = formatCountdown(fireTime);
        }
      }, 500);
    });
  }

  // Precise wait for the last few seconds using a tight loop
  const remaining = fireTime.getTime() - Date.now();
  if (remaining > 0) {
    if (remaining > 100) {
      await new Promise((resolve) =>
        setTimeout(resolve, remaining - 100)
      );
    }

    // Tight spin-wait for the final milliseconds
    while (Date.now() < fireTime.getTime()) {
      // Spin-wait — burns CPU but gives sub-ms precision
    }
  }

  console.log(chalk.bold.green("  🟢 FIRING!\n"));
}

function formatCountdown(target: Date): string {
  const diff = target.getTime() - Date.now();
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);

  if (hours > 0) {
    return `  Waiting... ${hours}h ${minutes}m ${seconds}s remaining`;
  }
  if (minutes > 0) {
    return `  Waiting... ${minutes}m ${seconds}s remaining`;
  }
  return `  Waiting... ${seconds}s remaining`;
}
