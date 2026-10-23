export const ROTATION_MS = 5 * 60 * 1000;

export class Rotation {
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.paused = false;
    this.remaining = ROTATION_MS;
    this.deadline = clock() + ROTATION_MS;
  }
  reset() {
    this.remaining = ROTATION_MS;
    this.deadline = this.clock() + ROTATION_MS;
  }
  toggle() {
    if (this.paused) this.deadline = this.clock() + this.remaining;
    else this.remaining = this.left();
    this.paused = !this.paused;
  }
  left() {
    return Math.max(0, this.paused ? this.remaining : this.deadline - this.clock());
  }
}
