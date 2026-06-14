const prisma = require('./db')

function tenantSource(landlordId = null, source = 'main') {
  return landlordId || source || 'main'
}

async function findLineTenant(lineUserId, landlordId = null, source = 'main') {
  const scopedSource = tenantSource(landlordId, source)
  let tenant = await prisma.tenant.findFirst({
    where: { lineUserId, source: scopedSource, landlordId }
  })

  // Migrate records created before users were isolated by Bot source.
  if (!tenant && landlordId) {
    tenant = await prisma.tenant.findFirst({ where: { lineUserId, landlordId } })
    if (tenant && tenant.source !== scopedSource) {
      tenant = await prisma.tenant.update({
        where: { id: tenant.id },
        data: { source: scopedSource }
      })
    }
  } else if (!tenant && !landlordId && scopedSource === 'main') {
    const legacyLandlordTenant = await prisma.tenant.findFirst({
      where: { lineUserId, source: 'main', landlordId: { not: null } }
    })
    if (legacyLandlordTenant) {
      await prisma.tenant.update({
        where: { id: legacyLandlordTenant.id },
        data: { source: legacyLandlordTenant.landlordId }
      })
    }
  }

  return tenant
}

async function upsertLineTenant({ lineUserId, landlordId = null, source = 'main', data = {} }) {
  const scopedSource = tenantSource(landlordId, source)
  const existing = await findLineTenant(lineUserId, landlordId, source)

  if (existing) {
    return prisma.tenant.update({
      where: { id: existing.id },
      data: { ...data, landlordId, source: scopedSource }
    })
  }

  return prisma.tenant.create({
    data: { lineUserId, landlordId, source: scopedSource, ...data }
  })
}

module.exports = { findLineTenant, upsertLineTenant }
