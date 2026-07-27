import { TICKS_PER_SECOND } from '../sim/simulation';

/**
 * How fast game time runs against real time at normal speed.
 *
 * The tick is the unit of game time and every duration in the game is measured
 * in ticks, so pacing the whole game is a matter of deciding how much real time
 * one tick takes rather than rebalancing every building. Turn this one number
 * up to make the game brisker.
 *
 * A quarter puts the game at five ticks a second, or an even 200ms each —
 * whole numbers wherever the pace is reasoned about, which a third was not.
 */
export const BASE_SPEED = 1 / 4;

/**
 * Fixed-timestep game loop.
 *
 * The simulation always advances in whole ticks of the same size, whatever the
 * display is doing — that is what keeps a game on a 120Hz phone identical to
 * the same game on a 60Hz laptop, and what makes replays and saves exact.
 * Rendering happens once per animation frame and interpolates between ticks.
 *
 * Game speed multiplies how many ticks a second of real time buys, so it never
 * changes the tick itself.
 */
export class GameLoop {
  private readonly step: () => void;
  private readonly draw: (alpha: number) => void;

  private running = false;
  private frame = 0;
  private lastTime = 0;
  private accumulator = 0;
  private speed = 1;

  /** Real milliseconds one tick occupies at speed 1. */
  private readonly tickMs = 1000 / (TICKS_PER_SECOND * BASE_SPEED);

  constructor(step: () => void, draw: (alpha: number) => void) {
    this.step = step;
    this.draw = draw;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 0 pauses the simulation; the view keeps drawing. */
  setSpeed(speed: number): void {
    this.speed = Math.max(0, speed);
  }

  getSpeed(): number {
    return this.speed;
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;

    // Clamp the gap so a backgrounded tab does not try to catch up an hour of
    // simulation the moment it returns.
    const elapsed = Math.min(250, now - this.lastTime);
    this.lastTime = now;
    this.accumulator += elapsed * this.speed;

    let steps = 0;
    while (this.accumulator >= this.tickMs && steps < MAX_STEPS_PER_FRAME) {
      this.step();
      this.accumulator -= this.tickMs;
      steps += 1;
    }

    // If we hit the ceiling the machine cannot keep up; drop the backlog rather
    // than spiral into ever longer frames.
    if (steps >= MAX_STEPS_PER_FRAME) this.accumulator = 0;

    // How far into the next tick the frame falls. Handing this to the renderer
    // lets it draw between ticks, so movement stays smooth however few ticks a
    // second the current pace calls for.
    this.draw(Math.min(1, this.accumulator / this.tickMs));
    this.frame = requestAnimationFrame(this.tick);
  };
}

const MAX_STEPS_PER_FRAME = 12;
