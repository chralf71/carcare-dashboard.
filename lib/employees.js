const { paginate, unique } = require('./pagination');
function employeeId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  throw new Error('Invalid employee ID');
}
async function employeeDirectory(client) {
  const records = await paginate(client, '/employees', { shop: client.shop });
  const employees = unique(records, employee => {
    if (employee.shopId !== undefined && employeeId(employee.shopId) !== client.shop) throw new Error('Wrong employee shop');
    if (typeof employee.firstName !== 'string' || typeof employee.lastName !== 'string') throw new Error('Invalid employee name');
    const name = `${employee.firstName.trim()} ${employee.lastName.trim()}`.trim();
    if (!name) throw new Error('Missing employee name');
    return { id: employeeId(employee.id), name };
  });
  return new Map(employees.map(employee => [employee.id, employee.name]));
}
module.exports = { employeeDirectory, employeeId };
