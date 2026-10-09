mod-ui
======

This is the UI for the MOD software. It's a webserver that delivers an HTML5 interface and communicates with mod-host.
It also communicates with the MOD hardware, but does not depend on it to run.

Install
-------

There are instructions for installing in a 64-bit Debian based Linux environment.
It will work in x86, other Linux distributions and Mac, but you might need to adjust the instructions.

The following packages will be required::

    $ sudo apt-get install virtualenv python3-pip python3-dev git build-essential libasound2-dev libjack-jackd2-dev liblilv-dev libjpeg-dev zlib1g-dev

NOTE: libjack-jackd2-dev can be replaced by libjack-dev if you are using JACK1; libjpeg-dev is needed for python-pillow, at least on my system.

Start by cloning the repository::

    $ git clone git://github.com/moddevices/mod-ui
    $ cd mod-ui

Create a python virtualenv::

    $ virtualenv modui-env
    $ source modui-env/bin/activate

Install python requirements::

    $ pip3 install -r requirements.txt

Compile libmod_utils::

    $ make -C utils

Run
---

Before running the server, you need to activate your virtualenv
(if you have just done that during installation, you can skip this step, but you'll need to do this again when you open a new shell)::

    $ source modui-env/bin/activate

mod-ui depends on mod-host and the JACK server running in order to make sound. So after you have JACK setup and running, in another terminal do::

    $ mod-host -n -p 5555 -f 5556

If you do not have mod-host, you can tell mod-ui to fake the connection to the audio backend.
You will not get any audio, but you will be able to load plugins, make connections, save pedalboards and all that. For this, run::

    $ export MOD_DEV_HOST=1

And now you are ready to start the webserver::

    $ export MOD_DEV_ENVIRONMENT=0
    $ python3 ./server.py

Setting the environment variables is needed when developing on a PC.
Open your browser and point to http://localhost:8888/.

API documentation
-----------------

``docs/openapi.yml`` describes everything the backend exposes to the browser: the HTTP endpoints, the WebSocket
messages (``/websocket``, ``/rpbsocket``, ``/rplsocket``), the server-rendered pages and the other channels.
Open it with any OpenAPI viewer (Swagger UI, Redoc, the VS Code OpenAPI extension) or lint it with::

    $ npx @redocly/cli lint docs/openapi.yml

TypeScript client (modui-client)
--------------------------------

``html/js/lib/modui-client/`` contains a small, typed client for the backend (``fetch`` + WebSocket).
It is optional: the existing UI does not depend on it and Python-only work needs none of this.

The sources live in ``html/js/lib/modui-client/src/`` (one module per area) and the tests in ``test/``.
The build bundles them into one plain JavaScript file, ``html/js/lib/modui-client.js``. That file is **generated and not versioned** (see ``.gitignore``);
``index.html`` loads it, ``setup.py`` and ``mod-deploy.sh`` pick it up with the other ``html/js/lib/*.js`` files.
If you do not build it, the page still works, the browser just reports a 404 for that script.

Requirements: Node.js 22.12 or newer.

Build, watch and test::

    $ cd html/js/lib/modui-client
    $ npm install
    $ npm run build      # writes html/js/lib/modui-client.js
    $ npm run watch      # rebuilds on change, with an inline source map
    $ npm test           # type check + unit tests (vitest)

npm 11 may warn that esbuild's install script was not approved; the build works without it.

Release builds must run ``npm install && npm run build`` in that folder before installing ``html/``,
otherwise ``modui-client.js`` is missing from the package.

Usage in the page (or in the browser console), where it is available as ``window.ModUiClient``::

    const client = new ModUiClient();
    const pedalboards = await client.pedalboards.list();
    const info = await pedalboards[0].info();
    await client.device.load(info);      // resolves after the WebSocket "loading_end"
    await client.device.loadDefault();   // empty "Untitled" pedalboard
    await client.device.currentPedalboard.save();             // overwrite the running pedalboard
    await client.device.currentPedalboard.saveAs('My copy');  // save it as a new pedalboard

    // Live editing of the running pedalboard
    const gain = (await client.device.plugins.list()).find((plugin) => plugin.label === 'Gain');
    const { plugins, connections, ports } = client.device.currentPedalboard;
    const instance = await plugins.add(gain, { x: 200, y: 100 });
    const [capture] = await ports.audio.output();    // ports of the pedalboard itself: audio/midi/cv x input()/output(), or ports.list()
    const connection = await connections.connect(capture, instance.ports.audio.input[0]);   // output -> input, same type
    await connections.disconnect(connection);
    await instance.params.get('gain').setValue(3.5);   // control values: a live `value`, range checked
    await instance.setActive(false);                   // bypass (also isActive(), toggle())
    await instance.patchParams.get(uri).setValue('Verse');   // strings, paths, booleans, ...: typed, validated (also refresh())
    await instance.move({ x: 320, y: 140 });
    await plugins.remove(instance);

From another origin or from Node, pass ``new ModUiClient({ baseUrl: 'http://modduo.local' })``.
The developer guide, with architecture, class and sequence diagrams, is ``docs/modui-client.md``.
Every public symbol is documented in the sources (TSDoc); the current scope (pedalboards) and the planned API
are in ``docs/plans/2026-10-modui-client-pedalboard.md`` (live editing of the running pedalboard:
``docs/plans/2026-10-modui-client-pedalboard-graph.md``; patch parameters such as strings and file paths:
``docs/plans/2026-10-modui-client-patch-params.md``).

Known limitation: when the client loads a pedalboard while the classic UI is open, the canvas reloads through the
WebSocket, but the title shown by the classic UI is not updated.
