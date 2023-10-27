#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later
from test.util.plugins.carla_audiogain_s import CarlaAudioGainS


class PluginFactory:

    @staticmethod
    def get(uri):
        plugins = {
            plugin.uri: plugin
            for plugin in [
                CarlaAudioGainS()
            ]
        }

        return plugins[uri]
