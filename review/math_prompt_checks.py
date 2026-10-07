"""Check the actual outgoing system instructions, independent of their wording."""


def assert_math_prompt(testcase, messages):
    prompt = '\n'.join(message['content'] for message in messages if message['role'] == 'system')
    for marker in ('LaTeX', '$$', r'\sum', r'\frac', '下标', '上标'):
        testcase.assertIn(marker, prompt, f'Missing math output instruction: {marker}')
    testcase.assertNotIn('\f', prompt, 'A Python escape must not corrupt the LaTeX fraction command')
