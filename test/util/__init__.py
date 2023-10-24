#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later
from mod.development import FakeHMI, FakeHost
from mod.protocol import Protocol
from mod.session import UserPreferences
from modtools.utils import init as lv2_init

def create_host():
    lv2_init()

    # Avoid to except "Command is already registered"
    Protocol.COMMANDS_USED = []

    callback_hmi = lambda: None
    message_callback = lambda text: print(text)

    hmi = FakeHMI(callback_hmi)
    return FakeHost(hmi, UserPreferences(), message_callback)
