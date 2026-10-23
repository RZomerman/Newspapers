export function bindSwipes(element, canNavigate, onNavigate) {
  const pointers = new Set();
  let gesture;

  element.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    pointers.add(event.pointerId);
    if (pointers.size !== 1 || !event.isPrimary || !canNavigate(event.target)) {
      gesture = undefined;
      return;
    }
    gesture = {
      id: event.pointerId, target: event.target,
      x: event.clientX, y: event.clientY, time: event.timeStamp
    };
  }, { passive: true });

  element.addEventListener('pointerup', event => {
    pointers.delete(event.pointerId);
    if (!gesture || gesture.id !== event.pointerId) return;
    const start = gesture;
    gesture = undefined;
    if (pointers.size || !canNavigate(start.target)) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const elapsed = event.timeStamp - start.time;
    if (elapsed >= 0 && elapsed <= 1500 && Math.abs(dx) >= 80 && Math.abs(dx) >= 2 * Math.abs(dy)) {
      onNavigate(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  const cancel = event => {
    pointers.delete(event.pointerId);
    if (gesture?.id === event.pointerId) gesture = undefined;
  };
  element.addEventListener('pointercancel', cancel);
  element.addEventListener('lostpointercapture', cancel);
}
