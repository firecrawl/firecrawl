import type { Queue } from "bullmq";

type BullBoardQueueBinder = (queue: Queue) => void;

const registeredQueues: Queue[] = [];
const binders: BullBoardQueueBinder[] = [];

/**
 * Registers an extra BullMQ queue so it appears in all Bull Board admin
 * instances, whether registered before or after the boards are initialized.
 */
export function registerBullBoardQueue(queue: Queue): void {
  if (registeredQueues.includes(queue)) {
    return;
  }
  registeredQueues.push(queue);
  for (const bind of binders) {
    bind(queue);
  }
}

/**
 * Connects a Bull Board adapter adder to receive both already-registered and
 * future queues.
 */
export function bindBullBoard(binder: BullBoardQueueBinder): void {
  binders.push(binder);
  for (const queue of registeredQueues) {
    binder(queue);
  }
}
