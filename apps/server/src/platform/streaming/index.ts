import { EventEmitter } from 'node:events';
export class EventHub {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(100);
  }
  publish(runId: string) {
    this.emitter.emit(runId);
  }
  subscribe(runId: string, listener: () => void) {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }
}
