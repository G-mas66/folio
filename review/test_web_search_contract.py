"""Free RSS search: query-only requests, provider redirects and safe source links."""
import asyncio
import unittest
from unittest.mock import patch

import httpx
from backend import ai, app


RSS = b'''<?xml version="1.0"?><rss><channel>
<item><title>Python official</title><link>https://docs.python.org/3/</link><description>Official &lt;b&gt;documentation&lt;/b&gt;</description></item>
<item><title>Bad scheme</title><link>javascript:alert(1)</link><description>bad</description></item>
<item><title>Credentials</title><link>https://user:secret@example.com/</link><description>bad</description></item>
<item><title>Python homepage</title><link>https://www.python.org/</link><description>Python language</description></item>
</channel></rss>'''


class SearchReview(unittest.TestCase):
    def invoke(self, *, query='Python official documentation', body=RSS, status=200, redirect=False):
        self.requests = []
        def handle(request):
            self.requests.append(request)
            if redirect and request.url.host == 'www.bing.com':
                return httpx.Response(302, headers={'Location': 'https://cn.bing.com/search?q=Python+official+documentation&format=rss'})
            return httpx.Response(status, content=body)
        original = httpx.AsyncClient
        def factory(**kwargs):
            return original(transport=httpx.MockTransport(handle), **kwargs)
        with patch.object(httpx, 'AsyncClient', factory):
            return asyncio.run(app.web_search_rss(query, first_result=6))

    def test_query_only_no_ai_credentials_and_safe_results(self):
        result = self.invoke()
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertEqual(request.method, 'GET')
        self.assertEqual(request.url.params['q'], 'Python official documentation')
        self.assertEqual(request.url.params['format'], 'rss')
        self.assertNotIn('authorization', request.headers)
        self.assertEqual(request.content, b'')
        self.assertEqual([source['id'] for source in result], ['W6', 'W7'])
        self.assertEqual([source['url'] for source in result], ['https://docs.python.org/3/', 'https://www.python.org/'])
        self.assertEqual(result[0]['snippet'], 'Official documentation')
        self.assertTrue(all(source['start_page'] == source['end_page'] == 0 for source in result))

    def test_bing_regional_redirect_still_yields_results(self):
        result = self.invoke(redirect=True)
        self.assertEqual(len(result), 2)
        self.assertEqual([request.url.host for request in self.requests], ['www.bing.com', 'cn.bing.com'])
        self.assertTrue(all('authorization' not in request.headers for request in self.requests))

    def test_invalid_queries_never_send_a_network_request(self):
        for query in ('', ' ' * 3, 'x' * 501, 123):
            with self.assertRaises(ai.AIError):
                self.invoke(query=query)
            self.assertEqual(self.requests, [])

    def test_provider_failure_or_no_results_never_fabricates_sources(self):
        for body, status in ((b'failure', 503), (b'<html>captcha</html>', 200), (b'<rss><channel/></rss>', 200), (b'not XML', 200)):
            with self.assertRaises(ai.AIError):
                self.invoke(body=body, status=status)

    def test_response_size_limit_stops_unbounded_reads(self):
        with self.assertRaises(ai.AIError):
            self.invoke(body=b'x' * 1_000_001)


if __name__ == '__main__':
    unittest.main()
