#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

import unittest
from uuid import uuid4

import pytest
from tornado.gen import Task
from tornado.testing import AsyncTestCase, gen_test

from test.util import create_host


class HostSnapshotTestCase(AsyncTestCase):

    @gen_test
    def test_save_invalid_plugin_instance(self):
        host = create_host()

        plugin_id = '/graph/' + str(uuid4()).replace('-', '_')
        preset_name = 'Sample'

        with pytest.raises(KeyError) as exception:
            yield Task(host.preset_save_new, plugin_id, preset_name)

        self.assertEqual(plugin_id, exception.value.args[0])

    @gen_test
    def test_save_valid_plugin_instance(self):
        host = create_host()

        # Add plugin
        plugin_id = str(uuid4()).replace('-', '_')
        plugin_graph_id = yield from self.add_plugin(host, plugin_id)

        host.pedalboard_modified = False

        # Create a preset
        snapshot_name = "Preset 1"
        snapshot_name_formatted = snapshot_name.replace(' ', '_')

        expected_bundle = '/' + plugin_id + '-' + snapshot_name_formatted + '.lv2'
        expected_uri = expected_bundle + '/' + snapshot_name_formatted + '.ttl'

        response = yield Task(host.preset_save_new, plugin_graph_id, snapshot_name)

        self.assertFalse(host.pedalboard_modified)

        self.assertTrue(response['ok'])
        self.assertTrue(response['bundle'].endswith(expected_bundle))
        self.assertTrue(response['uri'].endswith(expected_uri))

    @gen_test
    @unittest.skip("Preset saving isn't working on fake hmi")
    def test_save_valid_plugin_instance_same_bundle(self):
        host = create_host()

        # Add plugin
        plugin_id = str(uuid4()).replace('-', '_')
        plugin_graph_id = yield from self.add_plugin(host, plugin_id)

        host.pedalboard_modified = False

        snapshot_name = "Preset 1"
        snapshot_name_formatted = snapshot_name.replace(' ', '_')

        # Create a preset
        response_1 = yield Task(host.preset_save_new, plugin_graph_id, snapshot_name)
        # Create other preset with same name
        response_2 = yield Task(host.preset_save_new, plugin_graph_id, snapshot_name)

        expected_bundle = '/' + plugin_id + '-' + snapshot_name_formatted + '.lv2'
        expected_uri = expected_bundle + '/' + snapshot_name_formatted + '.ttl'

        self.assertFalse(host.pedalboard_modified)

        self.assertTrue(response_1['ok'])
        self.assertTrue(response_1['bundle'].endswith(expected_bundle))
        self.assertTrue(response_1['uri'].endswith(expected_uri))

        self.assertTrue(response_2['ok'])
        self.assertFalse(response_2['bundle'].endswith(expected_bundle))
        self.assertFalse(response_2['uri'].endswith(expected_uri))

    @gen_test
    @unittest.skip("Preset saving isn't working on fake hmi")
    def test_update(self):
        host = create_host()

        # Add plugin
        plugin_id = str(uuid4()).replace('-', '_')
        plugin_graph_id = yield from self.add_plugin(host, plugin_id)

        host.pedalboard_modified = False

        # Create a preset
        snapshot_name = "Preset 1"
        save_response = yield Task(host.preset_save_new, plugin_graph_id, snapshot_name)

        # Change plugin value
        original_value = host.plugins[host.mapper.get_id_without_creating(plugin_graph_id)]['ports']['gain']
        new_value = 1.47
        yield Task(host.paramhmi_set, plugin_id, "gain", new_value)

        # Updating a preset
        update_response = yield Task(
            host.preset_save_replace,
            plugin_graph_id,
            save_response['uri'],
            save_response['bundle'],
            snapshot_name
        )

        self.assertTrue(update_response['ok'])

    def add_plugin(self, host, plugin_id):
        plugin_graph_id = '/graph/' + plugin_id
        uri = 'http://kxstudio.sf.net/carla/plugins/audiogain_s'
        ok = yield Task(host.add_plugin, plugin_graph_id, uri, 0.0, 0.0)
        self.assertTrue(ok)
        return plugin_graph_id
