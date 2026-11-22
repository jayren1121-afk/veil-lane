import Phaser from 'phaser';

/** A styled HTML <input> placed in the Phaser DOM layer (scales with the canvas). */
export function addTextInput(
  scene: Phaser.Scene,
  x: number,
  y: number,
  options: { width?: number; placeholder?: string; value?: string; maxLength?: number; upper?: boolean } = {},
): { dom: Phaser.GameObjects.DOMElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = options.placeholder ?? '';
  input.value = options.value ?? '';
  input.maxLength = options.maxLength ?? 16;
  input.autocomplete = 'off';
  input.spellcheck = false;
  Object.assign(input.style, {
    width: `${options.width ?? 260}px`,
    height: '42px',
    boxSizing: 'border-box',
    padding: '0 14px',
    borderRadius: '8px',
    border: '1px solid #56bfd2',
    background: 'rgba(9, 23, 37, 0.92)',
    color: '#e6eef7',
    fontSize: options.upper ? '22px' : '17px',
    fontFamily: 'Arial, sans-serif',
    letterSpacing: options.upper ? '6px' : 'normal',
    textTransform: options.upper ? 'uppercase' : 'none',
    textAlign: options.upper ? 'center' : 'left',
    outline: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  // Keep Phaser keyboard handlers (e.g. draft search) from eating keystrokes.
  input.addEventListener('keydown', event => event.stopPropagation());
  const dom = scene.add.dom(x, y, input);
  return { dom, input };
}

/** An empty <div> in the DOM layer (used to host the Google button). */
export function addDomBox(scene: Phaser.Scene, x: number, y: number, width: number, height: number) {
  const div = document.createElement('div');
  Object.assign(div.style, { width: `${width}px`, height: `${height}px`, display: 'flex', justifyContent: 'center' });
  const dom = scene.add.dom(x, y, div);
  return { dom, div };
}
