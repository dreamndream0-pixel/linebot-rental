const cron = require('node-cron')
const prisma = require('./db')

function startCronJobs(client) {
  // 每月1號早上9點 + 5號早上9點，提醒繳租
  cron.schedule('0 9 1 * *', async () => {
    console.log('📅 執行收租提醒...')
    await sendRentReminders(client)
  })

  cron.schedule('0 9 5 * *', async () => {
    console.log('📅 執行收租提醒（補發）...')
    await sendRentReminders(client)
  })

  console.log('✅ 排程工作已啟動')
}

async function sendRentReminders(client) {
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true, propertyId: { not: null } },
    include: { property: true }
  })

  for (const tenant of tenants) {
    if (!tenant.lineUserId || !tenant.property) continue

    const message = {
      type: 'flex',
      altText: '📢 收租提醒',
      contents: {
        type: 'bubble',
        header: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#7A9E7E',
          paddingAll: '15px',
          contents: [
            { type: 'text', text: '💰 繳租提醒', weight: 'bold', color: '#ffffff', size: 'lg' }
          ]
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            { type: 'text', text: `${tenant.property.title}`, weight: 'bold', size: 'md' },
            { type: 'text', text: `本月租金：NT$ ${tenant.property.price.toLocaleString()}`, size: 'sm', color: '#555555' },
            { type: 'text', text: `繳納期限：本月 ${tenant.rentDue} 號前`, size: 'sm', color: '#555555' },
            { type: 'separator', margin: 'md' },
            { type: 'text', text: '請記得準時繳納，謝謝！🙏', size: 'xs', color: '#888888', wrap: true }
          ]
        }
      }
    }

    try {
      await client.pushMessage(tenant.lineUserId, message)
      console.log(`✅ 已通知租客：${tenant.lineUserId}`)
    } catch (err) {
      console.error(`❌ 通知失敗：${tenant.lineUserId}`, err.message)
    }
  }
}

module.exports = { startCronJobs }
