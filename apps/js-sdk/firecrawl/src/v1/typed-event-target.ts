// Vendored from typescript-event-target 1.1.1, MIT License,
// Copyright (c) 2022 Jonas "DerZade" Schade. https://github.com/DerZade/typescript-event-target

export type TypedEventListener<M, T extends keyof M> = (
  evt: M[T],
) => void | Promise<void>;

export interface TypedEventListenerObject<M, T extends keyof M> {
  handleEvent: (evt: M[T]) => void | Promise<void>;
}

export type TypedEventListenerOrEventListenerObject<M, T extends keyof M> =
  | TypedEventListener<M, T>
  | TypedEventListenerObject<M, T>;

type ValueIsEvent<T> = {
  [key in keyof T]: Event;
};

export interface TypedEventTarget<M extends ValueIsEvent<M>> {
  addEventListener: <T extends keyof M & string>(
    type: T,
    listener: TypedEventListenerOrEventListenerObject<M, T> | null,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: <T extends keyof M & string>(
    type: T,
    callback: TypedEventListenerOrEventListenerObject<M, T> | null,
    options?: EventListenerOptions | boolean,
  ) => void;
  /** @deprecated Use `dispatchTypedEvent` for type safety. */
  dispatchEvent: (event: Event) => boolean;
}

/** EventTarget whose listeners and dispatches are typed by an event map. */
export class TypedEventTarget<M extends ValueIsEvent<M>> extends EventTarget {
  dispatchTypedEvent<T extends keyof M>(_type: T, event: M[T]): boolean {
    return super.dispatchEvent(event);
  }
}
