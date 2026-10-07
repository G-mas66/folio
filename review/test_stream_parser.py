"""SSE framing, think tags and tool delta shape checked independently."""
import asyncio
import json
import unittest
from unittest.mock import patch

import httpx
from backend import ai


def packet(delta, finish=None):
    return ('data: ' + json.dumps({'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}, ensure_ascii=False) + '\n\n').encode()


class StreamParserReview(unittest.TestCase):
    def collect(self, wire, *, tools=None, status=200):
        captured = []
        class Chunks(httpx.AsyncByteStream):
            async def __aiter__(self):
                for offset in range(0, len(wire), 5):
                    yield wire[offset:offset + 5]
        def handle(request):
            captured.append(request)
            return httpx.Response(status, stream=Chunks())
        original = httpx.AsyncClient
        def factory(**kwargs):
            return original(transport=httpx.MockTransport(handle), **kwargs)
        async def run():
            return [event async for event in ai.stream_chat_completion(
                [{'role': 'user', 'content': '测试'}], model='exact-model', tools=tools,
                config=('https://provider.example/custom/?route=a%2Bb', 'default', 'fake-key'),
            )]
        with patch.object(httpx, 'AsyncClient', factory), patch.object(ai, '_record_usage'):
            events = asyncio.run(run())
        self.assertEqual(str(captured[0].url), 'https://provider.example/custom/?route=a%2Bb')
        self.assertTrue(json.loads(captured[0].content)['stream'])
        return events

    def test_one_character_deltas_are_emitted_immediately(self):
        wire = packet({'content': '你'}) + packet({'content': '好'}) + packet({}, 'stop') + b'data: [DONE]\n\n'
        events = self.collect(wire)
        self.assertEqual([event['text'] for event in events if event['type'] == 'content_delta'], ['你', '好'])

    def test_split_think_tags_and_unicode_separate_actual_reasoning(self):
        parts = ['<thi', 'nk>实际', '思考</th', 'ink>正式', '回答']
        events = self.collect(b''.join(packet({'content': part}) for part in parts) + packet({}, 'stop') + b'data: [DONE]\n\n')
        result = events[-1]['result']
        self.assertEqual(result['reasoning'], '实际思考')
        self.assertEqual(result['content'], '正式回答')
        self.assertNotIn('<think>', ''.join(event.get('text', '') for event in events))

    def test_fragmented_tool_calls_have_no_stream_only_index_in_next_message(self):
        tool = [{'type': 'function', 'function': {'name': 'read_paper', 'parameters': {'type': 'object'}}}]
        wire = packet({'tool_calls': [{'index': 0, 'id': 'call_1', 'type': 'function', 'function': {'name': 'read_', 'arguments': '{"query":'}}]})
        wire += packet({'tool_calls': [{'index': 0, 'function': {'name': 'paper', 'arguments': '"samples"}'}}]})
        wire += packet({}, 'tool_calls') + b'data: [DONE]\n\n'
        result = self.collect(wire, tools=tool)[-1]['result']
        call = result['message']['tool_calls'][0]
        self.assertEqual(set(call), {'id', 'type', 'function'})
        self.assertEqual(call['function'], {'name': 'read_paper', 'arguments': '{"query":"samples"}'})

    def test_contradictory_tool_calls_and_stop_are_rejected(self):
        tool = [{'type': 'function', 'function': {'name': 'read_paper', 'parameters': {'type': 'object'}}}]
        wire = packet({'content': '回答', 'tool_calls': [{'index': 0, 'id': 'call_1', 'function': {'name': 'read_paper', 'arguments': '{}'}}]}) + packet({}, 'stop') + b'data: [DONE]\n\n'
        with self.assertRaises(ai.AIError):
            self.collect(wire, tools=tool)

    def test_unclosed_thinking_is_not_a_completed_answer(self):
        wire = packet({'content': '<think>思考尚未结束'}) + packet({}, 'stop') + b'data: [DONE]\n\n'
        with self.assertRaises(ai.AIError):
            self.collect(wire)

    def test_reasoning_alias_does_not_become_answer_text(self):
        wire = packet({'reasoning': '实际推理'}) + packet({'content': '实际回答'}) + packet({}, 'stop') + b'data: [DONE]\n\n'
        result = self.collect(wire)[-1]['result']
        self.assertEqual(result['reasoning'], '实际推理')
        self.assertEqual(result['content'], '实际回答')


if __name__ == '__main__':
    unittest.main()
