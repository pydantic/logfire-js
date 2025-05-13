import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const getLatLng = tool({
    description: 'Get the latitude and longitude of a location',
    parameters: z.object({
        location_description: z.string().describe('A description of a location')
    }),
    execute: async ({ location_description }) => {
        const locations = {
            'london': { lat: 51.5074, lng: -0.1278, timezone: 'Europe/London' },
            'wiltshire': { lat: 51.3492, lng: -1.9927, timezone: 'Europe/London' },
            'new york': { lat: 40.7128, lng: -74.0060, timezone: 'America/New_York' },
            'tokyo': { lat: 35.6762, lng: 139.6503, timezone: 'Asia/Tokyo' }
        };

        const location = locations[location_description.toLowerCase()];
        if (!location) {
            throw new Error('Location not found');
        }
        return location;
    }
});

const getWeather = tool({
    description: 'Get comprehensive weather data for a location',
    parameters: z.object({
        lat: z.number().describe('Latitude of the location'),
        lng: z.number().describe('Longitude of the location'),
        include_historical: z.boolean().optional().describe('Include historical weather data')
    }),
    execute: async ({ lat, lng, include_historical = false }) => {
        const current = {
            temperature: '21°C',
            description: 'Sunny',
            humidity: '65%',
            wind_speed: '12 km/h',
            pressure: '1013 hPa',
            visibility: '10 km',
            uv_index: '5'
        };

        const forecast = [
            { date: '2024-03-20', temperature: '22°C', description: 'Partly Cloudy' },
            { date: '2024-03-21', temperature: '20°C', description: 'Light Rain' },
            { date: '2024-03-22', temperature: '19°C', description: 'Cloudy' },
            { date: '2024-03-23', temperature: '21°C', description: 'Sunny' },
            { date: '2024-03-24', temperature: '23°C', description: 'Clear' }
        ];

        const historical = include_historical ? [
            { date: '2024-03-13', temperature: '18°C', description: 'Rainy' },
            { date: '2024-03-14', temperature: '17°C', description: 'Cloudy' },
            { date: '2024-03-15', temperature: '19°C', description: 'Partly Cloudy' }
        ] : [];

        return {
            current,
            forecast,
            historical
        };
    }
});

const tools = {
    get_lat_lng: getLatLng,
    get_weather: getWeather
} as const;

async function getWeatherInfo() {
    
    try {
        const { text, toolResults } = await generateText({
            model: openai('gpt-4'),
            maxSteps: 15,
            messages: [
                {
                    role: 'system',
                    content: `You are a sophisticated weather analysis system. 
                    Use the available tools to:
                    1. Get location coordinates
                    2. Generate detailed weather reports
                    Be thorough and include all relevant data.`
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Analyze the weather conditions in London and New York. '
                        }
                    ]
                }
            ],
            tools,
            experimental_telemetry: {
                isEnabled: true,
                functionId: 'weather-function',
            },
        });

        console.log('\nWeather Analysis:', text);
        console.log('\nTool Results:', JSON.stringify(toolResults, null, 2));
    } catch (error) {
        console.error('Error:', error);
    }
}

getWeatherInfo()
