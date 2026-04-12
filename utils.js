export function uuid() {
    return 'id-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8);
}

export function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}

export function showToast(msg, error = false) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.style.backgroundColor = error ? '#f43f5e' : '#10b981';
    document.getElementById('toast-text').innerText = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 2500);
}

export function showAlertModal(title, message) {
    const modal = document.getElementById('alert-modal');
    if (!modal) return;
    document.getElementById('alert-title').innerText = title;
    document.getElementById('alert-message').innerText = message;
    modal.classList.remove('hidden');
}

export function closeAlertModal() {
    const modal = document.getElementById('alert-modal');
    if (modal) modal.classList.add('hidden');
}

export function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

export function exportHistory(division) {
    if (!division.matchHistory || division.matchHistory.length === 0) {
        showToast('无历史记录可导出', true);
        return;
    }
    const dataStr = JSON.stringify(division.matchHistory, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `腕力赛_${division.name}_历史.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('历史已导出');
}

export function exportData(state) {
    const dataStr = JSON.stringify(state, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '腕力王数据备份.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('导出成功');
}

export function importDataPrompt(callback) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const imported = JSON.parse(ev.target.result);
                callback(imported);
            } catch (err) {
                alert('文件格式错误');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

// 拼音转换（自动带声调）
export function getPinyin(text) {
    if (!text) return '';
    try {
        if (window.pinyinPro && typeof window.pinyinPro.pinyin === 'function') {
            // 输出带声调的拼音，例如 "zhāng sān"
            let py = window.pinyinPro.pinyin(text, { toneType: 'symbol', type: 'array' });
            return py.join(' ').toLowerCase();
        } else if (window.pinyin && typeof window.pinyin === 'function') {
            return window.pinyin(text, { style: 'normal' }).join(' ').toLowerCase();
        }
    } catch(e) {
        console.warn('拼音转换失败', e);
    }
    return '';
}