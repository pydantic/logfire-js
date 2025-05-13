export const aiSDKAttrTextGeneration = {
  'ai.model.id': 'gpt-4',
  'ai.model.provider': 'openai.chat',
  'ai.operationId': 'ai.generateText.doGenerate',
  'ai.prompt.format': 'messages',
  'ai.prompt.messages':
    '[{"role":"system","content":"You are a sophisticated weather analysis system. \\n                    Use the available tools to:\\n                    1. Get location coordinates\\n                    2. Analyze weather images\\n                    3. Generate detailed weather reports\\n                    Be thorough and include all relevant data."},{"role":"user","content":[{"type":"text","text":"Analyze the weather conditions in London and New York. \\n                    Process the weather image at \'http://127.0.0.1:8008/weather_image_s.jpg\'.\\n                    Generate a comprehensive weather report for both locations."}]},{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_CxtriP90qBV77ZfK8s2ngg3A","toolName":"get_lat_lng","args":{"location_description":"London"}}]},{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_CxtriP90qBV77ZfK8s2ngg3A","toolName":"get_lat_lng","result":{"lat":51.5074,"lng":-0.1278,"timezone":"Europe/London"}}]},{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_fcXAgy5E8dmptP1XFLlhwff7","toolName":"get_weather","args":{"lat":51.5074,"lng":-0.1278,"include_historical":true}}]},{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_fcXAgy5E8dmptP1XFLlhwff7","toolName":"get_weather","result":{"current":{"temperature":"21°C","description":"Sunny","humidity":"65%","wind_speed":"12 km/h","pressure":"1013 hPa","visibility":"10 km","uv_index":"5"},"forecast":[{"date":"2024-03-20","temperature":"22°C","description":"Partly Cloudy"},{"date":"2024-03-21","temperature":"20°C","description":"Light Rain"},{"date":"2024-03-22","temperature":"19°C","description":"Cloudy"},{"date":"2024-03-23","temperature":"21°C","description":"Sunny"},{"date":"2024-03-24","temperature":"23°C","description":"Clear"}],"historical":[{"date":"2024-03-13","temperature":"18°C","description":"Rainy"},{"date":"2024-03-14","temperature":"17°C","description":"Cloudy"},{"date":"2024-03-15","temperature":"19°C","description":"Partly Cloudy"}]}}]},{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_IqtIYDPKcboXvFarJnU2Yd3f","toolName":"get_lat_lng","args":{"location_description":"New York"}}]},{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_IqtIYDPKcboXvFarJnU2Yd3f","toolName":"get_lat_lng","result":{"lat":40.7128,"lng":-74.006,"timezone":"America/New_York"}}]},{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_TE0DaS4Zl1BEfYVhywLqq3Ue","toolName":"get_weather","args":{"lat":40.7128,"lng":-74.006,"include_historical":true}}]},{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_TE0DaS4Zl1BEfYVhywLqq3Ue","toolName":"get_weather","result":{"current":{"temperature":"21°C","description":"Sunny","humidity":"65%","wind_speed":"12 km/h","pressure":"1013 hPa","visibility":"10 km","uv_index":"5"},"forecast":[{"date":"2024-03-20","temperature":"22°C","description":"Partly Cloudy"},{"date":"2024-03-21","temperature":"20°C","description":"Light Rain"},{"date":"2024-03-22","temperature":"19°C","description":"Cloudy"},{"date":"2024-03-23","temperature":"21°C","description":"Sunny"},{"date":"2024-03-24","temperature":"23°C","description":"Clear"}],"historical":[{"date":"2024-03-13","temperature":"18°C","description":"Rainy"},{"date":"2024-03-14","temperature":"17°C","description":"Cloudy"},{"date":"2024-03-15","temperature":"19°C","description":"Partly Cloudy"}]}}]},{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_jDFe0rRcl7OWmed5LbawN0zY","toolName":"analyze_weather_image","args":{"image_url":"http://127.0.0.1:8008/weather_image_s.jpg","location":"London"}}]},{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_jDFe0rRcl7OWmed5LbawN0zY","toolName":"analyze_weather_image","result":{"conditions":"Overcast","confidence":0.85,"timestamp":"2025-05-07T13:32:55.168Z"}}]},{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_hdqwEk4JZTxnC5ha8kBhZcNz","toolName":"analyze_weather_image","args":{"image_url":"http://127.0.0.1:8008/weather_image_s.jpg","location":"New York"}}]},{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_hdqwEk4JZTxnC5ha8kBhZcNz","toolName":"analyze_weather_image","result":{"conditions":"Overcast","confidence":0.85,"timestamp":"2025-05-07T13:32:57.634Z"}}]},{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_zCqxzWc7DDXw0zG3S1tWxUZy","toolName":"generate_weather_report","args":{"location":"London","data":{"current":{"temperature":"21°C","description":"Sunny"},"forecast":[{"date":"2024-03-20","temperature":"22°C","description":"Partly Cloudy"},{"date":"2024-03-21","temperature":"20°C","description":"Light Rain"},{"date":"2024-03-22","temperature":"19°C","description":"Cloudy"},{"date":"2024-03-23","temperature":"21°C","description":"Sunny"},{"date":"2024-03-24","temperature":"23°C","description":"Clear"}],"historical":[{"date":"2024-03-13","temperature":"18°C","description":"Rainy"},{"date":"2024-03-14","temperature":"17°C","description":"Cloudy"},{"date":"2024-03-15","temperature":"19°C","description":"Partly Cloudy"}]}}}]},{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_zCqxzWc7DDXw0zG3S1tWxUZy","toolName":"generate_weather_report","result":{"report_path":"reports/london-report.pdf","generated_at":"2025-05-07T13:33:14.832Z"}}]},{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_5XZvrqg7dh1qqHhT51dUPDDK","toolName":"generate_weather_report","args":{"location":"New York","data":{"current":{"temperature":"21°C","description":"Sunny"},"forecast":[{"date":"2024-03-20","temperature":"22°C","description":"Partly Cloudy"},{"date":"2024-03-21","temperature":"20°C","description":"Light Rain"},{"date":"2024-03-22","temperature":"19°C","description":"Cloudy"},{"date":"2024-03-23","temperature":"21°C","description":"Sunny"},{"date":"2024-03-24","temperature":"23°C","description":"Clear"}],"historical":[{"date":"2024-03-13","temperature":"18°C","description":"Rainy"},{"date":"2024-03-14","temperature":"17°C","description":"Cloudy"},{"date":"2024-03-15","temperature":"19°C","description":"Partly Cloudy"}]}}}]},{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_5XZvrqg7dh1qqHhT51dUPDDK","toolName":"generate_weather_report","result":{"report_path":"reports/new-york-report.pdf","generated_at":"2025-05-07T13:33:23.956Z"}}]}]',
  'ai.prompt.toolChoice': '{"type":"auto"}',
  'ai.prompt.tools': [
    '{"type":"function","name":"get_lat_lng","description":"Get the latitude and longitude of a location","parameters":{"type":"object","properties":{"location_description":{"type":"string","description":"A description of a location"}},"required":["location_description"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}',
    '{"type":"function","name":"get_weather","description":"Get comprehensive weather data for a location","parameters":{"type":"object","properties":{"lat":{"type":"number","description":"Latitude of the location"},"lng":{"type":"number","description":"Longitude of the location"},"include_historical":{"type":"boolean","description":"Include historical weather data"}},"required":["lat","lng"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}',
    '{"type":"function","name":"analyze_weather_image","description":"Analyze weather conditions from an image","parameters":{"type":"object","properties":{"image_url":{"type":"string","description":"URL of the weather image"},"location":{"type":"string","description":"Location where the image was taken"}},"required":["image_url","location"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}',
    '{"type":"function","name":"generate_weather_report","description":"Generate a PDF weather report","parameters":{"type":"object","properties":{"location":{"type":"string","description":"Location for the weather report"},"data":{"type":"object","properties":{"current":{"type":"object","properties":{"temperature":{"type":"string"},"description":{"type":"string"}},"required":["temperature","description"],"additionalProperties":false},"forecast":{"type":"array","items":{"type":"object","properties":{"date":{"type":"string"},"temperature":{"type":"string"},"description":{"type":"string"}},"required":["date","temperature","description"],"additionalProperties":false}},"historical":{"type":"array","items":{"type":"object","properties":{"date":{"type":"string"},"temperature":{"type":"string"},"description":{"type":"string"}},"required":["date","temperature","description"],"additionalProperties":false}}},"required":["current","forecast","historical"],"additionalProperties":false}},"required":["location","data"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}',
  ],
  'ai.response.finishReason': 'stop',
  'ai.response.id': 'chatcmpl-BUZBkNNkA1dE29QCBGI1PHI4vKcAW',
  'ai.response.model': 'gpt-4-0613',
  'ai.response.text':
    'The weather conditions in London and New York have been analyzed and comprehensive weather reports have been generated for both locations.\n\nFor London:\n- Current weather: 21°C, Sunny\n- Forecast: \n  - 2024-03-20: 22°C, Partly Cloudy\n  - 2024-03-21: 20°C, Light Rain\n  - 2024-03-22: 19°C, Cloudy\n  - 2024-03-23: 21°C, Sunny\n  - 2024-03-24: 23°C, Clear\n- Historical data:\n  - 2024-03-13: 18°C, Rainy\n  - 2024-03-14: 17°C, Cloudy\n  - 2024-03-15: 19°C, Partly Cloudy\n\nThe weather image analysis for London shows overcast conditions with a confidence of 85%.\n\nThe comprehensive weather report for London can be found [here](reports/london-report.pdf).\n\nFor New York:\n- Current weather: 21°C, Sunny\n- Forecast: \n  - 2024-03-20: 22°C, Partly Cloudy\n  - 2024-03-21: 20°C, Light Rain\n  - 2024-03-22: 19°C, Cloudy\n  - 2024-03-23: 21°C, Sunny\n  - 2024-03-24: 23°C, Clear\n- Historical data:\n  - 2024-03-13: 18°C, Rainy\n  - 2024-03-14: 17°C, Cloudy\n  - 2024-03-15: 19°C, Partly Cloudy\n\nThe weather image analysis for New York shows overcast conditions with a confidence of 85%.\n\nThe comprehensive weather report for New York can be found [here](reports/new-york-report.pdf).',
  'ai.response.timestamp': '2025-05-07T13:33:24.000Z',
  'ai.settings.maxRetries': 2,
  'ai.telemetry.functionId': 'weather-function',
  'ai.usage.completionTokens': 416,
  'ai.usage.promptTokens': 1507,

  final_result:
    'The weather conditions in London and New York have been analyzed and comprehensive weather reports have been generated for both locations.\n\nFor London:\n- Current weather: 21°C, Sunny\n- Forecast: \n  - 2024-03-20: 22°C, Partly Cloudy\n  - 2024-03-21: 20°C, Light Rain\n  - 2024-03-22: 19°C, Cloudy\n  - 2024-03-23: 21°C, Sunny\n  - 2024-03-24: 23°C, Clear\n- Historical data:\n  - 2024-03-13: 18°C, Rainy\n  - 2024-03-14: 17°C, Cloudy\n  - 2024-03-15: 19°C, Partly Cloudy\n\nThe weather image analysis for London shows overcast conditions with a confidence of 85%.\n\nThe comprehensive weather report for London can be found [here](reports/london-report.pdf).\n\nFor New York:\n- Current weather: 21°C, Sunny\n- Forecast: \n  - 2024-03-20: 22°C, Partly Cloudy\n  - 2024-03-21: 20°C, Light Rain\n  - 2024-03-22: 19°C, Cloudy\n  - 2024-03-23: 21°C, Sunny\n  - 2024-03-24: 23°C, Clear\n- Historical data:\n  - 2024-03-13: 18°C, Rainy\n  - 2024-03-14: 17°C, Cloudy\n  - 2024-03-15: 19°C, Partly Cloudy\n\nThe weather image analysis for New York shows overcast conditions with a confidence of 85%.\n\nThe comprehensive weather report for New York can be found [here](reports/new-york-report.pdf).',
  'gen_ai.request.model': 'gpt-4',
  'gen_ai.response.finish_reasons': ['stop'],
  'gen_ai.response.id': 'chatcmpl-BUZBkNNkA1dE29QCBGI1PHI4vKcAW',
  'gen_ai.response.model': 'gpt-4-0613',
  'gen_ai.system': 'openai.chat',
  'gen_ai.usage.input_tokens': 1507,
  'gen_ai.usage.output_tokens': 416,
  'operation.name': 'ai.generateText.doGenerate weather-function',
  'resource.name': 'weather-function',
}

export const logfireAttrEventsTextGeneration = [
  {
    content:
      'You are a sophisticated weather analysis system. \n                    Use the available tools to:\n                    1. Get location coordinates\n                    2. Analyze weather images\n                    3. Generate detailed weather reports\n                    Be thorough and include all relevant data.',
    'event.name': 'gen_ai.system.message',
    role: 'system',
  },
  {
    content: [
      "Analyze the weather conditions in London and New York. \n                    Process the weather image at 'http://127.0.0.1:8008/weather_image_s.jpg'.\n                    Generate a comprehensive weather report for both locations.",
    ],
    'event.name': 'gen_ai.user.message',
    role: 'user',
  },
  {
    content: null,
    'event.name': 'gen_ai.assistant.message',
    role: 'assistant',
    tool_calls: [
      {
        function: {
          arguments: {
            location_description: 'London',
          },
          name: 'get_lat_lng',
        },
        id: 'call_CxtriP90qBV77ZfK8s2ngg3A',
        type: 'tool-call',
      },
    ],
  },
  {
    content: {
      lat: 51.5074,
      lng: -0.1278,
      timezone: 'Europe/London',
    },
    'event.name': 'gen_ai.tool.message',
    functionName: 'get_lat_lng',
    id: 'call_CxtriP90qBV77ZfK8s2ngg3A',
    result: {
      lat: 51.5074,
      lng: -0.1278,
      timezone: 'Europe/London',
    },
    role: 'tool',
    toolCallId: 'call_CxtriP90qBV77ZfK8s2ngg3A',
    toolName: 'get_lat_lng',
    type: 'tool-result',
  },
  {
    content: null,
    'event.name': 'gen_ai.assistant.message',
    role: 'assistant',
    tool_calls: [
      {
        function: {
          arguments: {
            include_historical: true,
            lat: 51.5074,
            lng: -0.1278,
          },
          name: 'get_weather',
        },
        id: 'call_fcXAgy5E8dmptP1XFLlhwff7',
        type: 'tool-call',
      },
    ],
  },
  {
    content: {
      current: {
        description: 'Sunny',
        humidity: '65%',
        pressure: '1013 hPa',
        temperature: '21°C',
        uv_index: '5',
        visibility: '10 km',
        wind_speed: '12 km/h',
      },
      forecast: [
        {
          date: '2024-03-20',
          description: 'Partly Cloudy',
          temperature: '22°C',
        },
        {
          date: '2024-03-21',
          description: 'Light Rain',
          temperature: '20°C',
        },
        {
          date: '2024-03-22',
          description: 'Cloudy',
          temperature: '19°C',
        },
        {
          date: '2024-03-23',
          description: 'Sunny',
          temperature: '21°C',
        },
        {
          date: '2024-03-24',
          description: 'Clear',
          temperature: '23°C',
        },
      ],
      historical: [
        {
          date: '2024-03-13',
          description: 'Rainy',
          temperature: '18°C',
        },
        {
          date: '2024-03-14',
          description: 'Cloudy',
          temperature: '17°C',
        },
        {
          date: '2024-03-15',
          description: 'Partly Cloudy',
          temperature: '19°C',
        },
      ],
    },
    'event.name': 'gen_ai.tool.message',
    functionName: 'get_weather',
    id: 'call_fcXAgy5E8dmptP1XFLlhwff7',
    result: {
      current: {
        description: 'Sunny',
        humidity: '65%',
        pressure: '1013 hPa',
        temperature: '21°C',
        uv_index: '5',
        visibility: '10 km',
        wind_speed: '12 km/h',
      },
      forecast: [
        {
          date: '2024-03-20',
          description: 'Partly Cloudy',
          temperature: '22°C',
        },
        {
          date: '2024-03-21',
          description: 'Light Rain',
          temperature: '20°C',
        },
        {
          date: '2024-03-22',
          description: 'Cloudy',
          temperature: '19°C',
        },
        {
          date: '2024-03-23',
          description: 'Sunny',
          temperature: '21°C',
        },
        {
          date: '2024-03-24',
          description: 'Clear',
          temperature: '23°C',
        },
      ],
      historical: [
        {
          date: '2024-03-13',
          description: 'Rainy',
          temperature: '18°C',
        },
        {
          date: '2024-03-14',
          description: 'Cloudy',
          temperature: '17°C',
        },
        {
          date: '2024-03-15',
          description: 'Partly Cloudy',
          temperature: '19°C',
        },
      ],
    },
    role: 'tool',
    toolCallId: 'call_fcXAgy5E8dmptP1XFLlhwff7',
    toolName: 'get_weather',
    type: 'tool-result',
  },
  {
    content: null,
    'event.name': 'gen_ai.assistant.message',
    role: 'assistant',
    tool_calls: [
      {
        function: {
          arguments: {
            location_description: 'New York',
          },
          name: 'get_lat_lng',
        },
        id: 'call_IqtIYDPKcboXvFarJnU2Yd3f',
        type: 'tool-call',
      },
    ],
  },
  {
    content: {
      lat: 40.7128,
      lng: -74.006,
      timezone: 'America/New_York',
    },
    'event.name': 'gen_ai.tool.message',
    functionName: 'get_lat_lng',
    id: 'call_IqtIYDPKcboXvFarJnU2Yd3f',
    result: {
      lat: 40.7128,
      lng: -74.006,
      timezone: 'America/New_York',
    },
    role: 'tool',
    toolCallId: 'call_IqtIYDPKcboXvFarJnU2Yd3f',
    toolName: 'get_lat_lng',
    type: 'tool-result',
  },
  {
    content: null,
    'event.name': 'gen_ai.assistant.message',
    role: 'assistant',
    tool_calls: [
      {
        function: {
          arguments: {
            include_historical: true,
            lat: 40.7128,
            lng: -74.006,
          },
          name: 'get_weather',
        },
        id: 'call_TE0DaS4Zl1BEfYVhywLqq3Ue',
        type: 'tool-call',
      },
    ],
  },
  {
    content: {
      current: {
        description: 'Sunny',
        humidity: '65%',
        pressure: '1013 hPa',
        temperature: '21°C',
        uv_index: '5',
        visibility: '10 km',
        wind_speed: '12 km/h',
      },
      forecast: [
        {
          date: '2024-03-20',
          description: 'Partly Cloudy',
          temperature: '22°C',
        },
        {
          date: '2024-03-21',
          description: 'Light Rain',
          temperature: '20°C',
        },
        {
          date: '2024-03-22',
          description: 'Cloudy',
          temperature: '19°C',
        },
        {
          date: '2024-03-23',
          description: 'Sunny',
          temperature: '21°C',
        },
        {
          date: '2024-03-24',
          description: 'Clear',
          temperature: '23°C',
        },
      ],
      historical: [
        {
          date: '2024-03-13',
          description: 'Rainy',
          temperature: '18°C',
        },
        {
          date: '2024-03-14',
          description: 'Cloudy',
          temperature: '17°C',
        },
        {
          date: '2024-03-15',
          description: 'Partly Cloudy',
          temperature: '19°C',
        },
      ],
    },
    'event.name': 'gen_ai.tool.message',
    functionName: 'get_weather',
    id: 'call_TE0DaS4Zl1BEfYVhywLqq3Ue',
    result: {
      current: {
        description: 'Sunny',
        humidity: '65%',
        pressure: '1013 hPa',
        temperature: '21°C',
        uv_index: '5',
        visibility: '10 km',
        wind_speed: '12 km/h',
      },
      forecast: [
        {
          date: '2024-03-20',
          description: 'Partly Cloudy',
          temperature: '22°C',
        },
        {
          date: '2024-03-21',
          description: 'Light Rain',
          temperature: '20°C',
        },
        {
          date: '2024-03-22',
          description: 'Cloudy',
          temperature: '19°C',
        },
        {
          date: '2024-03-23',
          description: 'Sunny',
          temperature: '21°C',
        },
        {
          date: '2024-03-24',
          description: 'Clear',
          temperature: '23°C',
        },
      ],
      historical: [
        {
          date: '2024-03-13',
          description: 'Rainy',
          temperature: '18°C',
        },
        {
          date: '2024-03-14',
          description: 'Cloudy',
          temperature: '17°C',
        },
        {
          date: '2024-03-15',
          description: 'Partly Cloudy',
          temperature: '19°C',
        },
      ],
    },
    role: 'tool',
    toolCallId: 'call_TE0DaS4Zl1BEfYVhywLqq3Ue',
    toolName: 'get_weather',
    type: 'tool-result',
  },
  {
    content: null,
    'event.name': 'gen_ai.assistant.message',
    role: 'assistant',
    tool_calls: [
      {
        function: {
          arguments: {
            image_url: 'http://127.0.0.1:8008/weather_image_s.jpg',
            location: 'London',
          },
          name: 'analyze_weather_image',
        },
        id: 'call_jDFe0rRcl7OWmed5LbawN0zY',
        type: 'tool-call',
      },
    ],
  },
  {
    content: {
      conditions: 'Overcast',
      confidence: 0.85,
      timestamp: '2025-05-07T13:32:55.168Z',
    },
    'event.name': 'gen_ai.tool.message',
    functionName: 'analyze_weather_image',
    id: 'call_jDFe0rRcl7OWmed5LbawN0zY',
    result: {
      conditions: 'Overcast',
      confidence: 0.85,
      timestamp: '2025-05-07T13:32:55.168Z',
    },
    role: 'tool',
    toolCallId: 'call_jDFe0rRcl7OWmed5LbawN0zY',
    toolName: 'analyze_weather_image',
    type: 'tool-result',
  },
  {
    content: null,
    'event.name': 'gen_ai.assistant.message',
    role: 'assistant',
    tool_calls: [
      {
        function: {
          arguments: {
            image_url: 'http://127.0.0.1:8008/weather_image_s.jpg',
            location: 'New York',
          },
          name: 'analyze_weather_image',
        },
        id: 'call_hdqwEk4JZTxnC5ha8kBhZcNz',
        type: 'tool-call',
      },
    ],
  },
  {
    content: {
      conditions: 'Overcast',
      confidence: 0.85,
      timestamp: '2025-05-07T13:32:57.634Z',
    },
    'event.name': 'gen_ai.tool.message',
    functionName: 'analyze_weather_image',
    id: 'call_hdqwEk4JZTxnC5ha8kBhZcNz',
    result: {
      conditions: 'Overcast',
      confidence: 0.85,
      timestamp: '2025-05-07T13:32:57.634Z',
    },
    role: 'tool',
    toolCallId: 'call_hdqwEk4JZTxnC5ha8kBhZcNz',
    toolName: 'analyze_weather_image',
    type: 'tool-result',
  },
  {
    content: null,
    'event.name': 'gen_ai.assistant.message',
    role: 'assistant',
    tool_calls: [
      {
        function: {
          arguments: {
            data: {
              current: {
                description: 'Sunny',
                temperature: '21°C',
              },
              forecast: [
                {
                  date: '2024-03-20',
                  description: 'Partly Cloudy',
                  temperature: '22°C',
                },
                {
                  date: '2024-03-21',
                  description: 'Light Rain',
                  temperature: '20°C',
                },
                {
                  date: '2024-03-22',
                  description: 'Cloudy',
                  temperature: '19°C',
                },
                {
                  date: '2024-03-23',
                  description: 'Sunny',
                  temperature: '21°C',
                },
                {
                  date: '2024-03-24',
                  description: 'Clear',
                  temperature: '23°C',
                },
              ],
              historical: [
                {
                  date: '2024-03-13',
                  description: 'Rainy',
                  temperature: '18°C',
                },
                {
                  date: '2024-03-14',
                  description: 'Cloudy',
                  temperature: '17°C',
                },
                {
                  date: '2024-03-15',
                  description: 'Partly Cloudy',
                  temperature: '19°C',
                },
              ],
            },
            location: 'London',
          },
          name: 'generate_weather_report',
        },
        id: 'call_zCqxzWc7DDXw0zG3S1tWxUZy',
        type: 'tool-call',
      },
    ],
  },
  {
    content: {
      generated_at: '2025-05-07T13:33:14.832Z',
      report_path: 'reports/london-report.pdf',
    },
    'event.name': 'gen_ai.tool.message',
    functionName: 'generate_weather_report',
    id: 'call_zCqxzWc7DDXw0zG3S1tWxUZy',
    result: {
      generated_at: '2025-05-07T13:33:14.832Z',
      report_path: 'reports/london-report.pdf',
    },
    role: 'tool',
    toolCallId: 'call_zCqxzWc7DDXw0zG3S1tWxUZy',
    toolName: 'generate_weather_report',
    type: 'tool-result',
  },
  {
    content: null,
    'event.name': 'gen_ai.assistant.message',
    role: 'assistant',
    tool_calls: [
      {
        function: {
          arguments: {
            data: {
              current: {
                description: 'Sunny',
                temperature: '21°C',
              },
              forecast: [
                {
                  date: '2024-03-20',
                  description: 'Partly Cloudy',
                  temperature: '22°C',
                },
                {
                  date: '2024-03-21',
                  description: 'Light Rain',
                  temperature: '20°C',
                },
                {
                  date: '2024-03-22',
                  description: 'Cloudy',
                  temperature: '19°C',
                },
                {
                  date: '2024-03-23',
                  description: 'Sunny',
                  temperature: '21°C',
                },
                {
                  date: '2024-03-24',
                  description: 'Clear',
                  temperature: '23°C',
                },
              ],
              historical: [
                {
                  date: '2024-03-13',
                  description: 'Rainy',
                  temperature: '18°C',
                },
                {
                  date: '2024-03-14',
                  description: 'Cloudy',
                  temperature: '17°C',
                },
                {
                  date: '2024-03-15',
                  description: 'Partly Cloudy',
                  temperature: '19°C',
                },
              ],
            },
            location: 'New York',
          },
          name: 'generate_weather_report',
        },
        id: 'call_5XZvrqg7dh1qqHhT51dUPDDK',
        type: 'tool-call',
      },
    ],
  },
  {
    content: {
      generated_at: '2025-05-07T13:33:23.956Z',
      report_path: 'reports/new-york-report.pdf',
    },
    'event.name': 'gen_ai.tool.message',
    functionName: 'generate_weather_report',
    id: 'call_5XZvrqg7dh1qqHhT51dUPDDK',
    result: {
      generated_at: '2025-05-07T13:33:23.956Z',
      report_path: 'reports/new-york-report.pdf',
    },
    role: 'tool',
    toolCallId: 'call_5XZvrqg7dh1qqHhT51dUPDDK',
    toolName: 'generate_weather_report',
    type: 'tool-result',
  },
  {
    content:
      'The weather conditions in London and New York have been analyzed and comprehensive weather reports have been generated for both locations.\n\nFor London:\n- Current weather: 21°C, Sunny\n- Forecast: \n  - 2024-03-20: 22°C, Partly Cloudy\n  - 2024-03-21: 20°C, Light Rain\n  - 2024-03-22: 19°C, Cloudy\n  - 2024-03-23: 21°C, Sunny\n  - 2024-03-24: 23°C, Clear\n- Historical data:\n  - 2024-03-13: 18°C, Rainy\n  - 2024-03-14: 17°C, Cloudy\n  - 2024-03-15: 19°C, Partly Cloudy\n\nThe weather image analysis for London shows overcast conditions with a confidence of 85%.\n\nThe comprehensive weather report for London can be found [here](reports/london-report.pdf).\n\nFor New York:\n- Current weather: 21°C, Sunny\n- Forecast: \n  - 2024-03-20: 22°C, Partly Cloudy\n  - 2024-03-21: 20°C, Light Rain\n  - 2024-03-22: 19°C, Cloudy\n  - 2024-03-23: 21°C, Sunny\n  - 2024-03-24: 23°C, Clear\n- Historical data:\n  - 2024-03-13: 18°C, Rainy\n  - 2024-03-14: 17°C, Cloudy\n  - 2024-03-15: 19°C, Partly Cloudy\n\nThe weather image analysis for New York shows overcast conditions with a confidence of 85%.\n\nThe comprehensive weather report for New York can be found [here](reports/new-york-report.pdf).',
    'event.name': 'gen_ai.assistant.message',
    role: 'assistant',
  },
]
