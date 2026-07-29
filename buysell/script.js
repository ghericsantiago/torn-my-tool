document.addEventListener('DOMContentLoaded', function() {
    // Enhanced with all requested features
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    
    // Initialize date pickers
    flatpickr("#startDate", {
        dateFormat: "Y-m-d",
        defaultDate: todayUTC,
        allowInput: true,
        time_24hr: true,
        utc: true
    });
    
    flatpickr("#endDate", {
        dateFormat: "Y-m-d",
        defaultDate: todayUTC,
        allowInput: true,
        time_24hr: true,
        utc: true
    });

    // Data variables
    let originalBuyData = [];
    let originalSellData = [];
    let filteredBuyData = [];
    let filteredSellData = [];
    let itemCatalog = {};
    const BUY_LOG_TYPES = [1103, 1112, 1220, 1225, 4201, 4200];
    const SELL_LOG_TYPES = [1104, 1113, 1221, 1226, 4210, 4220];

    // v2 API returns a log type number, not a category string
    const LOG_TYPE_STORE = {
        1103: 'Item Market',  1104: 'Item Market',
        1112: 'Point Market', 1113: 'Point Market',
        1220: 'Bazaar',       1221: 'Bazaar',
        1225: 'Armoury',      1226: 'Armoury',
        4200: 'Trade',        4201: 'Trade',
        4210: 'Trade',        4220: 'Trade',
    };
    let valueChart = null;
    let currentSort = { column: null, direction: 'asc' };

    // Clear old catalog caches
    localStorage.removeItem('tornItemCatalog');
    localStorage.removeItem('tornItemCatalog_v2');

    // Load API key from localStorage if available
    const apiKeyInput = document.getElementById('apiKey');
    const savedApiKey = localStorage.getItem('tornApiKey');
    if (savedApiKey) {
        apiKeyInput.value = savedApiKey;
    }

    // Event listeners
    document.getElementById('refreshBtn').addEventListener('click', fetchData);
    document.getElementById('applyFilters').addEventListener('click', applyFilters);
    document.getElementById('clearFilters').addEventListener('click', clearFilters);
    document.getElementById('exportBtn').addEventListener('click', exportToCSV);
    document.getElementById('taxRate').addEventListener('input', applyFilters);
    
    // Debounced search
    let searchDebounce;
    document.getElementById('itemSearch').addEventListener('input', function() {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(applyFilters, 300);
    });

    // Save API key when changed
    apiKeyInput.addEventListener('change', function() {
        localStorage.setItem('tornApiKey', this.value.trim());
    });

    // Table sorting
    document.querySelectorAll('#buyTable th, #sellTable th').forEach(header => {
        header.classList.add('sortable');
        header.addEventListener('click', () => {
            const tableId = header.closest('table').id;
            const columnIndex = Array.from(header.parentNode.children).indexOf(header);
            sortTable(tableId, columnIndex);
        });
    });

    // Initial data fetch if API key exists
    if (savedApiKey) {
        fetchData();
    }

    function getApiKey() {
        return apiKeyInput.value.trim();
    }

    async function fetchData() {
        try {
            const TORN_API_KEY = getApiKey();
            if (!TORN_API_KEY) {
                alert('Please enter your API key');
                return;
            }

            showLoading(true);

            // Get current date filters
            const startDate = document.getElementById('startDate').value ? new Date(document.getElementById('startDate').value) : new Date();
            const endDate = document.getElementById('endDate').value ? new Date(document.getElementById('endDate').value) : new Date();

            startDate.setUTCHours(0, 0, 0, 0);
            endDate.setUTCHours(23, 59, 59, 999);

            const startTimestamp = Math.floor(startDate.getTime() / 1000);
            const endTimestamp = Math.floor(endDate.getTime() / 1000);

            // Fetch item catalog with caching — uses v1 which includes market_value
            if (Object.keys(itemCatalog).length === 0) {
                const cachedCatalog = localStorage.getItem('tornItemCatalog_v3');
                if (cachedCatalog) {
                    itemCatalog = JSON.parse(cachedCatalog);
                } else {
                    const catalogResponse = await fetchWithRetry(`https://api.torn.com/torn/?selections=items&key=${TORN_API_KEY}`);
                    const catalogData = await catalogResponse.json();
                    if (catalogData.error) throw new Error(catalogData.error.error);

                    console.log('[torn] sample item entry:', Object.entries(catalogData.items)[0]);

                    itemCatalog = {};
                    for (const [id, item] of Object.entries(catalogData.items)) {
                        itemCatalog[id] = {
                            name:  item.name,
                            price: item.market_value ?? 0
                        };
                    }
                    localStorage.setItem('tornItemCatalog_v3', JSON.stringify(itemCatalog));
                }
            }

            // Fetch logs with retry logic
            const [buyLogs, sellLogs] = await Promise.all([
                fetchWithRetry(`https://api.torn.com/v2/user/log?key=${TORN_API_KEY}&log=${BUY_LOG_TYPES.join(',')}&from=${startTimestamp}&to=${endTimestamp}`)
                    .then(res => res.json())
                    .then(data => data.log ? Object.values(data.log) : []),
                fetchWithRetry(`https://api.torn.com/v2/user/log?key=${TORN_API_KEY}&log=${SELL_LOG_TYPES.join(',')}&from=${startTimestamp}&to=${endTimestamp}`)
                    .then(res => res.json())
                    .then(data => data.log ? Object.values(data.log) : [])
            ]);
          
          
          
            originalBuyData = processLogs(buyLogs, 'buy');
            originalSellData = processLogs(sellLogs, 'sell');

            applyFilters();
            updateSummary();
            renderChart();

        } catch (error) {
            console.error('Error:', error);
            alert(`Error: ${error.message}`);
        } finally {
            showLoading(false);
        }
    }

    async function fetchWithRetry(url, retries = 3) {
        try {
            let response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);
            return response;
        } catch (error) {
            if (retries <= 0) throw error;
            console.log(`Retrying... (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            return fetchWithRetry(url, retries - 1);
        }
    }

    function storeFromTitle(title) {
        const t = (title || '').toLowerCase();
        if (t.includes('bazaar'))                          return 'Bazaar';
        if (t.includes('item market') || t.includes('city market')) return 'Item Market';
        if (t.includes('point market'))                    return 'Point Market';
        if (t.includes('armoury') || t.includes('armory')) return 'Armoury';
        if (t.includes('trade'))                           return 'Trade';
        if (t.includes('abroad') || t.includes('foreign') || t.includes('in mexico') || t.includes('in japan')) return 'Abroad';
        return '';
    }

    function processLogs(logs, type) {
        const itemsMap = new Map();

        if (logs.length) console.log('[torn] sample log entry:', logs[0]);

        logs.forEach(log => {
            const d = log.data || {};

            // Safely get item ID — some log types use data.item, others use data.items[0].id
            const itemId = d.item ?? d.items?.[0]?.id;
            if (!itemId) return;

            const catalog = itemCatalog[itemId] || { name: `Item ${itemId}`, price: 0 };
            const itemName = catalog.name;
            const currentPrice = catalog.price;
            // v2 API: try log.log (type number), then log.category, then parse from title
            const logType = log.log ?? log.log_type ?? log.type;
            const storeType = LOG_TYPE_STORE[logType] || log.category || storeFromTitle(log.title) || 'Unknown';
            const quantity = d.quantity ?? d.items?.[0]?.qty ?? 1;
            const costTotal = d.cost_total ?? d.cost ?? 0;
            const timestamp = log.timestamp * 1000;

            if (!itemsMap.has(itemName)) {
                itemsMap.set(itemName, {
                    item_name: itemName,
                    store_type: storeType,
                    total_quantity: 0,
                    total_amount: 0,
                    current_price: currentPrice,
                    last_transaction: timestamp,
                    item_id: itemId
                });
            }

            const item = itemsMap.get(itemName);
            item.total_quantity += quantity;
            item.total_amount += costTotal;
            if (timestamp > item.last_transaction) {
                item.last_transaction = timestamp;
            }
        });

        return Array.from(itemsMap.values()).map(item => ({
            ...item,
            avg_cost: item.total_quantity > 0 ? item.total_amount / item.total_quantity : 0
        }));
    }

    function applyFilters() {
        const itemSearch = document.getElementById('itemSearch').value.toLowerCase();

        filteredBuyData = originalBuyData.filter(item => 
            item.item_name.toLowerCase().includes(itemSearch)
        );

        filteredSellData = originalSellData.filter(item => 
            item.item_name.toLowerCase().includes(itemSearch)
        );

        populateTable('buyTableBody', filteredBuyData, 'buy');
        populateTable('sellTableBody', filteredSellData, 'sell');
        updateSummary();
        renderChart();
    }

    function clearFilters() {
        document.getElementById('itemSearch').value = '';
        applyFilters();
    }

    function getTaxRate() {
        return Math.max(0, Math.min(100, parseFloat(document.getElementById('taxRate').value) || 0));
    }

    function updateSummary() {
        const taxRate = getTaxRate();
        const totalItems = filteredBuyData.length + filteredSellData.length;
        const buyTotal = filteredBuyData.reduce((sum, item) => sum + item.total_amount, 0);
        const sellTotal = filteredSellData.reduce((sum, item) => sum + item.total_amount, 0);
        const profitLoss = sellTotal - buyTotal;
        const potentialIncome = filteredBuyData.reduce((sum, item) =>
            sum + (item.current_price * item.total_quantity * (1 - taxRate / 100)), 0);

        document.getElementById('buySummary').textContent = `${filteredBuyData.length} items ($${buyTotal.toLocaleString()})`;
        document.getElementById('sellSummary').textContent = `${filteredSellData.length} items ($${sellTotal.toLocaleString()})`;
        document.getElementById('totalItems').textContent = totalItems;
        document.getElementById('totalValue').textContent = `$${(buyTotal + sellTotal).toLocaleString()}`;
        document.getElementById('potentialIncome').textContent = `$${Math.round(potentialIncome).toLocaleString()}`;

        const profitElement = document.getElementById('profitLoss');
        profitElement.textContent = `$${Math.abs(profitLoss).toLocaleString()}`;
        profitElement.className = profitLoss >= 0 ? 'positive' : 'negative';
    }

    function renderChart() {
        const ctx = document.getElementById('valueChart').getContext('2d');
        
        // Group by item and calculate net value (sales - purchases)
        const itemsMap = new Map();
        
        // Process buys
        filteredBuyData.forEach(item => {
            if (!itemsMap.has(item.item_id)) {
                itemsMap.set(item.item_id, {
                    name: item.item_name,
                    buy: 0,
                    sell: 0
                });
            }
            itemsMap.get(item.item_id).buy += item.total_amount;
        });
        
        // Process sells
        filteredSellData.forEach(item => {
            if (!itemsMap.has(item.item_id)) {
                itemsMap.set(item.item_id, {
                    name: item.item_name,
                    buy: 0,
                    sell: 0
                });
            }
            itemsMap.get(item.item_id).sell += item.total_amount;
        });
        
        // Prepare chart data
        const chartData = Array.from(itemsMap.values())
            .filter(item => item.buy > 0 || item.sell > 0)
            .sort((a, b) => (b.sell - b.buy) - (a.sell - a.buy));
        
        const labels = chartData.map(item => item.name);
        const buyData = chartData.map(item => item.buy);
        const sellData = chartData.map(item => item.sell);
        const netData = chartData.map(item => item.sell - item.buy);

        if (valueChart) {
            valueChart.destroy();
        }

        valueChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Buy Value',
                        data: buyData,
                        backgroundColor: 'rgba(46, 204, 113, 0.7)',
                        borderColor: 'rgba(46, 204, 113, 1)',
                        borderWidth: 1
                    },
                    {
                        label: 'Sell Value',
                        data: sellData,
                        backgroundColor: 'rgba(231, 76, 60, 0.7)',
                        borderColor: 'rgba(231, 76, 60, 1)',
                        borderWidth: 1
                    },
                    {
                        label: 'Profit/Loss',
                        data: netData,
                        backgroundColor: netData.map(value => 
                            value >= 0 ? 'rgba(46, 204, 113, 0.7)' : 'rgba(231, 76, 60, 0.7)'
                        ),
                        borderColor: netData.map(value => 
                            value >= 0 ? 'rgba(46, 204, 113, 1)' : 'rgba(231, 76, 60, 1)'
                        ),
                        borderWidth: 1,
                        type: 'bar'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        stacked: false,
                    },
                    y: {
                        stacked: false,
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return '$' + value.toLocaleString();
                            }
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) label += ': ';
                                label += '$' + context.raw.toLocaleString();
                                return label;
                            }
                        }
                    }
                }
            }
        });
    }

    function sortTable(tableId, columnIndex) {
        const isBuyTable = tableId === 'buyTable';
        const data = isBuyTable ? [...filteredBuyData] : [...filteredSellData];
        const column = document.querySelector(`#${tableId} th:nth-child(${columnIndex + 1})`);
        
        // Remove previous sort indicators
        document.querySelectorAll(`#${tableId} th`).forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
        });
        
        // Determine sort direction
        let direction = 'asc';
        if (currentSort.column === columnIndex) {
            direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        }
        
        // Sort data
        data.sort((a, b) => {
            let aValue, bValue;
            
            switch(columnIndex) {
                case 0: // Item name
                    aValue = a.item_name.toLowerCase();
                    bValue = b.item_name.toLowerCase();
                    break;
                case 1: // Store type
                    aValue = a.store_type.toLowerCase();
                    bValue = b.store_type.toLowerCase();
                    break;
                case 2: // Quantity
                    aValue = a.total_quantity;
                    bValue = b.total_quantity;
                    break;
                case 3: // Avg price
                    aValue = a.avg_cost;
                    bValue = b.avg_cost;
                    break;
                case 4: // Total
                    aValue = a.total_amount;
                    bValue = b.total_amount;
                    break;
                case 5: // Current price
                    aValue = a.current_price;
                    bValue = b.current_price;
                    break;
                case 6: // Potential income
                    aValue = a.current_price * a.total_quantity;
                    bValue = b.current_price * b.total_quantity;
                    break;
                case 7: // Last transaction
                    aValue = a.last_transaction;
                    bValue = b.last_transaction;
                    break;
                default:
                    return 0;
            }
            
            if (direction === 'asc') {
                return aValue > bValue ? 1 : -1;
            } else {
                return aValue < bValue ? 1 : -1;
            }
        });
        
        // Update sorted data
        if (isBuyTable) {
            filteredBuyData = data;
        } else {
            filteredSellData = data;
        }
        
        // Update UI
        column.classList.add(`sorted-${direction}`);
        currentSort = { column: columnIndex, direction };
        populateTable(`${isBuyTable ? 'buy' : 'sell'}TableBody`, data, isBuyTable ? 'buy' : 'sell');
    }

    function populateTable(tableId, data, type) {
        const tableBody = document.getElementById(tableId);
        tableBody.innerHTML = '';

        if (!data || data.length === 0) {
            const row = document.createElement('tr');
            row.className = `${type}-row`;
            row.innerHTML = `<td colspan="8" style="text-align: center;">No matching items found</td>`;
            tableBody.appendChild(row);
            return;
        }

        const taxRate = getTaxRate();

        data.forEach(item => {
            const potentialIncome = item.current_price > 0
                ? Math.round(item.current_price * item.total_quantity * (1 - taxRate / 100))
                : null;
            const row = document.createElement('tr');
            row.className = `${type}-row`;
            row.innerHTML = `
                <td>${item.item_name}</td>
                <td><span class="store-badge">${item.store_type}</span></td>
                <td>${item.total_quantity.toLocaleString()}</td>
                <td>$${Math.round(item.avg_cost).toLocaleString()}</td>
                <td>$${item.total_amount.toLocaleString()}</td>
                <td>${item.current_price > 0 ? '$' + item.current_price.toLocaleString() : '—'}</td>
                <td>${potentialIncome !== null ? '$' + potentialIncome.toLocaleString() : '—'}</td>
                <td>${formatUTCDate(item.last_transaction)}</td>
            `;
            tableBody.appendChild(row);
        });
    }

    function exportToCSV() {
        const allData = [...filteredBuyData.map(item => ({ ...item, type: 'Buy' })), 
                     ...filteredSellData.map(item => ({ ...item, type: 'Sell' }))];
        
        if (allData.length === 0) {
            alert('No data to export');
            return;
        }
        
        const taxRate = getTaxRate();
        // CSV header
        let csv = 'Type,Item Name,Store,Quantity,Avg Price,Total Value,Current Price,Potential Income,Last Transaction\n';

        // CSV rows
        allData.forEach(item => {
            const potentialIncome = item.current_price > 0
                ? Math.round(item.current_price * item.total_quantity * (1 - taxRate / 100))
                : '';
            csv += `"${item.type}","${item.item_name}","${item.store_type}",${item.total_quantity},${Math.round(item.avg_cost)},${item.total_amount},${item.current_price || ''},${potentialIncome},"${formatUTCDate(item.last_transaction)}"\n`;
        });
        
        // Create download link
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `torn_portfolio_${new Date().toISOString().slice(0,10)}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function showLoading(show) {
        document.getElementById('buyLoading').style.display = show ? 'flex' : 'none';
        document.getElementById('sellLoading').style.display = show ? 'flex' : 'none';
        document.getElementById('buyTable').style.display = show ? 'none' : 'table';
        document.getElementById('sellTable').style.display = show ? 'none' : 'table';
    }

    function formatUTCDate(timestamp) {
        if (!timestamp) return 'N/A';
        return new Date(timestamp).toISOString().split('T')[0];
    }

    // Toggle API key input
    document.getElementById('toggleApiKey').addEventListener('click', function() {
        const apiKeyGroup = document.querySelector('.api-key-group');
        apiKeyGroup.style.display = apiKeyGroup.style.display === 'none' ? 'flex' : 'none';
    });

    // Save API key
    document.getElementById('saveApiKey').addEventListener('click', function() {
        const apiKey = document.getElementById('apiKey').value.trim();
        if (apiKey) {
            localStorage.setItem('tornApiKey', apiKey);
        }
    });

});