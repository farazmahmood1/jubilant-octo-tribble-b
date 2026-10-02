/**
 * Progress output for the command-line scripts. Everything goes to stderr, so a script's own
 * stdout (reports, trial balances) stays clean when piped.
 *
 * On a terminal it redraws one line; anywhere else (a pipe, CI) it prints a plain line at most
 * every 10% so logs stay short.
 */
const interactive = () => process.stderr.isTTY === true;

const clock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export interface Progress {
  /** `done` of `total` items finished; `note` is shown after the bar, e.g. the current order. */
  update: (done: number, note?: string) => void;
  /** Ends the bar with its final line. */
  finish: (summary?: string) => void;
}

/**
 * Anything written to stdout while a line is being redrawn (a log line) would land in the middle
 * of it, so clear the line first. Returns the function that puts stdout back.
 */
const guardStdout = (clear: () => void): (() => void) => {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    clear();
    return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original as typeof process.stdout.write;
  };
};

/** A bar for work with a known size: percent, count, elapsed time and an estimate of what is left. */
export const progressBar = (label: string, total: number): Progress => {
  const startedAt = Date.now();
  const tty = interactive();
  let lastDecile = -1;
  let drawn = false;
  const clear = () => {
    if (drawn) process.stderr.write('\r\x1b[K');
    drawn = false;
  };
  const restore = tty ? guardStdout(clear) : () => {};

  const render = (done: number, note?: string): string => {
    const fraction = total === 0 ? 1 : Math.min(1, done / total);
    const elapsed = Date.now() - startedAt;
    const eta = done > 0 && done < total ? ` · ~${clock((elapsed / done) * (total - done))} left` : '';
    const filled = Math.round(fraction * 24);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(24 - filled)}`;
    return `${label} ${bar} ${String(Math.round(fraction * 100)).padStart(3)}% ${done}/${total} · ${clock(elapsed)}${eta}${note ? ` · ${note}` : ''}`;
  };

  return {
    update(done, note) {
      if (tty) {
        process.stderr.write(`\r\x1b[K${render(done, note)}`);
        drawn = true;
        return;
      }
      const decile = total === 0 ? 10 : Math.floor((done / total) * 10);
      if (decile > lastDecile) {
        lastDecile = decile;
        console.error(render(done, note));
      }
    },
    finish(summary) {
      clear();
      restore();
      // Off a terminal the 100% line may already have printed.
      if (!tty && lastDecile >= 10 && !summary) return;
      console.error(`${render(total)}${summary ? ` — ${summary}` : ''}`);
    },
  };
};

/**
 * For work with no known size (a sync job pulling pages from an API): a spinner with the elapsed
 * time, so it is clear the command is alive. Returns a function that stops it.
 */
export const spinner = (label: string): (() => void) => {
  if (!interactive()) {
    console.error(`${label} started…`);
    return () => {};
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const startedAt = Date.now();
  let i = 0;
  let drawn = false;
  const clear = () => {
    if (drawn) process.stderr.write('\r\x1b[K');
    drawn = false;
  };
  const restore = guardStdout(clear);
  const draw = () => {
    process.stderr.write(`\r\x1b[K${frames[i++ % frames.length]} ${label} · ${clock(Date.now() - startedAt)} elapsed`);
    drawn = true;
  };
  draw();
  const timer = setInterval(draw, 120);
  return () => {
    clearInterval(timer);
    clear();
    restore();
  };
};
