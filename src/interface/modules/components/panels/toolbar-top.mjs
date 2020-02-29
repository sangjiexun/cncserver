/**
 * @file Top toolbar panel definition with bindings.
 */
/* globals cncserver */
import { html } from '/modules/hybrids.js';
import apiInit from '/modules/utils/api-init.mjs';

// Initialize the panel.
function init(host) {
  apiInit(() => {
    if (!host.initialized) {
      host.initialized = true;

      // Bind to pen updates.
      cncserver.socket.on('pen update', ({ state }) => {
        host.penState = state;
      });
    }
  });
}

// TODO: Add support for skip buffer park.
export default styles => ({
  initialized: false,
  penState: 'up',
  render: ({ penState }) => html`
    ${styles}

    <button-single
      title="Park"
      icon="home"
      style="warning"
      onclick="cncserver.api.pen.park()"
    ></button-single>

    <button-single
      title="Unlock & ⇱∅"
      icon="unlock"
      style="secondary"
      onclick="cncserver.api.motors.unlock().then(cncserver.api.pen.zero());"
    ></button-single>

    <button-toggle
      onchange="cncserver.api.pen.height(this.state ? 0 : 1)"
      on-title="Down ⭳"
      on-icon="pen"
      on-style="success"
      off-title="Up ↥"
      off-icon="pen"
      off-style="warning"
      state=${penState === 'up' || penState === 0}
    ></button-toggle>

    <label class="checkbox box is-pulled-right" style="padding: 0.1em 0.5em;">
      Direct
      <input type="checkbox" class="switch" id="skipbuffer">
    </label>
    ${init}
  `,
});