/**
 * Touch and mouse handling for the map.
 *
 * Written against Pointer Events so a finger, a stylus and a mouse all take the
 * same path. The map is the whole screen on a phone, so the gestures have to be
 * unambiguous: one finger pans or drags, two fingers pinch, a quick touch
 * selects, and a held touch opens the build menu where the thumb already is.
 */

export interface GestureHandlers {
  /** A quick touch that did not move. */
  onTap(x: number, y: number): void;
  /** A touch held in place. Fires once, before the pointer is released. */
  onLongPress(x: number, y: number): void;
  onDragStart(x: number, y: number): void;
  onDrag(x: number, y: number, dx: number, dy: number): void;
  onDragEnd(x: number, y: number): void;
  /** Pinch or wheel zoom, anchored at a point on screen. */
  onZoom(factor: number, x: number, y: number): void;
  /** Pointer moved without a button held — hover on desktop. */
  onHover(x: number, y: number): void;
}

/** Movement beyond this many pixels turns a touch into a drag. */
const DRAG_THRESHOLD = 8;
/** How long a touch must be held, in milliseconds, to count as a long press. */
const LONG_PRESS_MS = 420;

interface ActivePointer {
  x: number;
  y: number;
  readonly startX: number;
  readonly startY: number;
  readonly startedAt: number;
}

export function attachGestures(element: HTMLElement, handlers: GestureHandlers): () => void {
  const pointers = new Map<number, ActivePointer>();

  let dragging = false;
  let longPressFired = false;
  let longPressTimer = 0;
  let pinchDistance = 0;

  const localPosition = (event: PointerEvent): { x: number; y: number } => {
    const bounds = element.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const cancelLongPress = (): void => {
    if (longPressTimer) window.clearTimeout(longPressTimer);
    longPressTimer = 0;
  };

  const onPointerDown = (event: PointerEvent): void => {
    const position = localPosition(event);
    element.setPointerCapture(event.pointerId);

    pointers.set(event.pointerId, {
      x: position.x,
      y: position.y,
      startX: position.x,
      startY: position.y,
      startedAt: event.timeStamp,
    });

    if (pointers.size === 1) {
      dragging = false;
      longPressFired = false;
      cancelLongPress();
      longPressTimer = window.setTimeout(() => {
        if (dragging || pointers.size !== 1) return;
        longPressFired = true;
        handlers.onLongPress(position.x, position.y);
      }, LONG_PRESS_MS);
    } else {
      // A second finger cancels any pending tap or long press.
      cancelLongPress();
      if (dragging) {
        dragging = false;
        handlers.onDragEnd(position.x, position.y);
      }
      pinchDistance = currentPinchDistance();
    }
  };

  const currentPinchDistance = (): number => {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const pinchCentre = (): { x: number; y: number } => {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return { x: 0, y: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const onPointerMove = (event: PointerEvent): void => {
    const position = localPosition(event);

    const pointer = pointers.get(event.pointerId);
    if (!pointer) {
      handlers.onHover(position.x, position.y);
      return;
    }

    const previousX = pointer.x;
    const previousY = pointer.y;
    pointer.x = position.x;
    pointer.y = position.y;

    if (pointers.size >= 2) {
      const distance = currentPinchDistance();
      if (pinchDistance > 0 && distance > 0) {
        const centre = pinchCentre();
        handlers.onZoom(distance / pinchDistance, centre.x, centre.y);
      }
      pinchDistance = distance;
      return;
    }

    if (!dragging) {
      const moved = Math.hypot(position.x - pointer.startX, position.y - pointer.startY);
      if (moved < DRAG_THRESHOLD || longPressFired) return;

      dragging = true;
      cancelLongPress();
      handlers.onDragStart(pointer.startX, pointer.startY);
    }

    handlers.onDrag(position.x, position.y, position.x - previousX, position.y - previousY);
  };

  const finishPointer = (event: PointerEvent): void => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;

    const position = localPosition(event);
    pointers.delete(event.pointerId);
    cancelLongPress();

    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }

    if (pointers.size >= 1) {
      // Still pinching, or a finger lifted mid-pinch; re-anchor the remaining one.
      pinchDistance = currentPinchDistance();
      return;
    }

    if (dragging) {
      dragging = false;
      handlers.onDragEnd(position.x, position.y);
      return;
    }

    if (longPressFired) {
      longPressFired = false;
      return;
    }

    const held = event.timeStamp - pointer.startedAt;
    const moved = Math.hypot(position.x - pointer.startX, position.y - pointer.startY);
    if (moved < DRAG_THRESHOLD && held < LONG_PRESS_MS) {
      handlers.onTap(position.x, position.y);
    }
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const bounds = element.getBoundingClientRect();
    // A trackpad reports many small deltas; damping keeps zooming controllable.
    const factor = Math.exp(-event.deltaY * 0.0015);
    handlers.onZoom(factor, event.clientX - bounds.left, event.clientY - bounds.top);
  };

  const onContextMenu = (event: Event): void => event.preventDefault();

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', finishPointer);
  element.addEventListener('pointercancel', finishPointer);
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('contextmenu', onContextMenu);

  return () => {
    cancelLongPress();
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', finishPointer);
    element.removeEventListener('pointercancel', finishPointer);
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('contextmenu', onContextMenu);
  };
}
