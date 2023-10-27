#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

from unittest.mock import patch

from test.util.plugins.plugin_factory import PluginFactory


class MockModtoolsUtils:
    def __init__(self):
        self.module = patch('modtools.utils', autospec=True)
        self.mock = None

        self.patchers = []

    def start(self):
        self.mock = self.module.start()

        self.mock.init.return_value = None
        self.mock.cleanup.return_value = None

        self.register_mock('is_bundle_loaded', lambda bundlepath: True)

        self.register_mock('get_plugin_info_essentials', lambda uri: PluginFactory.get(uri).essential)

        self.register_mock('init_jack', lambda: True)
        self.register_mock('close_jack', lambda: None)

        self.register_mock('rescan_plugin_presets', lambda uri: None)

    def register_mock(self, function_name, side_effect):
        patcher = patch(f'mod.host.{function_name}')
        mock = patcher.start()
        mock.side_effect = side_effect
        self.patchers.append(patcher)

    def stop(self):
        if self.module is not None:
            self.module.stop()

        for mock in self.patchers:
            mock.stop()
