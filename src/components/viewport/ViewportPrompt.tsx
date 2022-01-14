import { CompositeDisposable, Disposable } from 'event-kit';
import { createRef, render } from 'preact';
import { CommandPrompt } from '../../command/CommandPrompt';
import { Editor } from '../../editor/Editor';

export default (editor: Editor) => {
    class Anon extends HTMLElement {
        private readonly disposable = new CompositeDisposable();

        connectedCallback() {
            editor.signals.promptAdded.add(this.render);
            editor.signals.promptRemoved.add(this.render);
            this.disposable.add(new Disposable(() => {
                editor.signals.promptAdded.remove(this.render);
                editor.signals.promptRemoved.remove(this.render);
            }));
            this.render();
        }

        disconnectedCallback() {
            this.disposable.dispose();
        }

        constructor() {
            super();
            this.render = this.render.bind(this);
        }

        render(prompt?: CommandPrompt) {
            if (prompt) {
                const ref = createRef();
                render(<div ref={ref}></div>, this);
                ref.current.appendChild(prompt);
            } else {
                render(<></>, this);
            }
        }
    }
    customElements.define('plasticity-viewport-prompt', Anon);
}