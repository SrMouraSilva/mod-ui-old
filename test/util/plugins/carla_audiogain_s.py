#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

class CarlaAudioGainS:
    def __init__(self):
        self.uri = 'http://kxstudio.sf.net/carla/plugins/audiogain_s'
        self.essential = {
            'buildEnvironment': 'http://lv2plug.in/ns/lv2core#hardRTCapable',
            'builder': 0,
            'controlInputs': [],
            'microVersion': 0,
            'minorVersion': 0,
            'monitoredOutputs': [],
            'parameters': [],
            'release': 0
        }