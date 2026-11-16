/* ScaleaStay: shared direct-booking calendar. No optimistic writes to booking state. */
(() => {
    'use strict';
    const D = window.ScaleaData;
    const preview = document.body.dataset.preview === 'true';
    const $ = id => document.getElementById(id);
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const initialDate = new Date();
    const state = { data: { bookings: [] }, currentDate: initialDate.getFullYear() < 2027 ? new Date(2027, 0, 1) : initialDate, selectedBooking: null };
    let loaded = false, online = false, saving = false, readError = false, writeError = false;
    let adapter = null, auth = null, generation = 0, activeQuote = null;
    const checkInInput = $('checkIn'), checkOutInput = $('checkOut'), priceInput = $('price');
    const errors = {
        INVALID_DATE: 'Проверьте дату: нужен настоящий день календаря.',
        INVALID_DATES: 'Дата выезда должна быть позже даты заезда.',
        INVALID_PRICE: 'Укажите положительную цену за ночь, не более двух знаков после запятой.',
        INVALID_BOOKING: 'В записи брони есть некорректные данные. Импорт отменён.',
        INVALID_DATA: 'Данные календаря имеют неподдерживаемый формат. Изменения заблокированы.',
        INVALID_IMPORT: 'Файл не похож на резервную копию калькулятора. Данные не изменены.',
        DUPLICATE_ID: 'В календаре или файле есть повторяющиеся номера броней. Изменения отменены.',
        ID_CONFLICT: 'Бронь с таким номером уже существует с другими данными. Импорт отменён.',
        OVERLAP: 'Эти даты уже заняты. Календарь мог обновиться с другого телефона. Выберите другие даты.',
        RECORD_CHANGED: 'Эта бронь изменилась на другом устройстве. Откройте её карточку заново.',
        DELETED_BOOKING: 'В копии есть ранее удалённая бронь. Импорт отменён, чтобы не восстановить её случайно.',
        UNSUPPORTED_YEAR: 'Автоматические цены заданы только для ночей 2027 года. Укажите цену вручную.'
    };
    function messageFor(error) {
        const code = error?.code;
        if (errors[code]) return errors[code];
        if (/permission|denied/i.test(String(code || error?.message || ''))) return 'Сервер не разрешил сохранить изменения. Введённые данные оставлены в форме.';
        return 'Не удалось подтвердить сохранение. Проверьте соединение и повторите действие. Введённые данные сохранены в форме.';
    }
    function showError(error) {
        const message = typeof error === 'string' ? error : messageFor(error);
        $('actionError').textContent = message;
        $('actionError').classList.remove('hidden');
        $('deleteModalError').textContent = message;
        $('deleteModalError').classList.remove('hidden');
        $('dataModalError').textContent = message;
        $('dataModalError').classList.remove('hidden');
    }
    function clearError() { ['actionError', 'deleteModalError', 'dataModalError'].forEach(id => $(id).classList.add('hidden')); }
    function canWrite() { return loaded && online && !saving && !readError; }
    function renderSync() {
        let kind, text;
        if (saving) {
            kind = 'saving';
            text = online ? 'Сохраняем на сервере… Не закрывайте калькулятор до подтверждения.' : 'Связь прервалась во время сохранения. Ждём подключения — не закрывайте калькулятор.';
        } else if (readError) {
            kind = 'error'; text = 'Не удалось загрузить календарь. Изменения заблокированы. Повторите загрузку страницы после восстановления доступа.';
        } else if (!online) {
            kind = 'offline'; text = loaded ? 'Нет связи. Показана последняя загруженная копия. Изменения будут доступны после подключения.' : 'Ждём соединения для загрузки календаря…';
        } else if (!loaded) {
            kind = 'loading'; text = 'Загружаем календарь… Изменения пока недоступны.';
        } else if (writeError) {
            kind = 'error'; text = 'Последнее изменение не сохранено. Данные оставлены в форме — проверьте сообщение и повторите действие.';
        } else {
            kind = 'ready'; text = preview ? 'Демонстрационный календарь синхронизирован между окнами.' : 'Календарь загружен · связь с сервером есть';
        }
        $('syncBanner').dataset.kind = kind;
        $('syncBanner').textContent = text;
        ['dataModalStatus', 'deleteModalStatus'].forEach(id => {
            $(id).textContent = text;
            $(id).dataset.kind = kind;
            $(id).classList.toggle('hidden', kind === 'ready');
        });
        $('cloudStatus').className = 'w-2 h-2 rounded-full ml-2 ' + (kind === 'ready' ? 'bg-emerald-400' : kind === 'error' ? 'bg-rose-500' : 'bg-amber-400');
        $('cloudStatus').title = text;
        document.querySelectorAll('[data-write]').forEach(element => { element.disabled = !canWrite(); });
        document.querySelectorAll('[data-export]').forEach(element => { element.disabled = !loaded || saving; });
    }
    function receiveData(raw) {
        try {
            state.data = D.normalizeData(raw);
            loaded = true; readError = false;
            render();
        } catch (error) {
            loaded = false; readError = true;
            showError(error);
        }
        renderSync();
    }
    function receiveConnection(value) { online = value; renderSync(); }
    function receiveError(error) { readError = true; loaded = false; showError(error); renderSync(); }

    async function runOperation(operation) {
        if (!canWrite()) {
            showError('Дождитесь загрузки календаря и соединения с сервером. Изменения пока недоступны.');
            return false;
        }
        const currentGeneration = generation;
        clearError(); writeError = false; saving = true; renderSync();
        try {
            await adapter.mutate(operation);
            if (currentGeneration !== generation) return false;
            clearError();
            return true;
        } catch (error) {
            if (currentGeneration === generation) { writeError = true; showError(error); }
            return false;
        } finally {
            if (currentGeneration === generation) { saving = false; renderSync(); }
        }
    }

    function firebaseAdapter(userGeneration) {
        const ref = firebase.database().ref('scalea_app_data');
        const connectedRef = firebase.database().ref('.info/connected');
        const active = callback => value => { if (generation === userGeneration) callback(value); };
        const onValue = active(snapshot => receiveData(snapshot.val()));
        const onConnection = active(snapshot => receiveConnection(snapshot.val() === true));
        const onError = active(receiveError);
        ref.on('value', onValue, onError);
        connectedRef.on('value', onConnection, onError);
        return {
            async mutate(operation) {
                let validationError = null;
                const result = await ref.transaction(current => {
                    validationError = null;
                    try { return D.reduceOperation(current, operation); }
                    catch (error) { validationError = error; return undefined; }
                }, undefined, false);
                if (!result.committed) throw validationError || new Error('Transaction aborted');
                // The live listener owns state. A transaction result may already be
                // older than a subsequent value event from another phone.
            },
            dispose() { ref.off('value', onValue); connectedRef.off('value', onConnection); }
        };
    }

    function resetForm() {
        $('bookingForm').reset();
        checkInInput.max = ''; checkOutInput.min = '';
        activeQuote = null; priceInput.value = '0'; $('liveTotal').textContent = '0 €';
        $('quoteHint').textContent = 'Прямые цены 2027 · квартира целиком · до 4 гостей. Уборка и электричество включены.';
    }
    function quoteMatches() {
        return activeQuote && activeQuote.start === checkInInput.value && activeQuote.end === checkOutInput.value && Number(priceInput.value) === activeQuote.value.averagePrice;
    }
    function calculateTotal() {
        try {
            const quote = quoteMatches() ? activeQuote.value : null;
            const booking = D.buildBooking({ id: 'draft', checkIn: checkInInput.value, checkOut: checkOutInput.value, price: priceInput.value, quote, createdAt: 'draft' });
            $('liveTotal').textContent = D.formatMoney(D.getBookingTotalCents(booking));
        } catch { $('liveTotal').textContent = '0 €'; }
    }
    function updateDatesFromTariffs() {
        activeQuote = null;
        if (!checkInInput.value || !checkOutInput.value || checkInInput.value >= checkOutInput.value) { calculateTotal(); return; }
        try {
            const quote = D.quoteStay(checkInInput.value, checkOutInput.value);
            activeQuote = { start: checkInInput.value, end: checkOutInput.value, value: quote };
            priceInput.value = quote.averagePrice;
            $('quoteHint').textContent = 'Расчёт по нашим ценам 2027 за каждую ночь. Цена за ночь показана в среднем; итог точный. Можно указать свою цену.';
        } catch (error) {
            priceInput.value = '0';
            $('quoteHint').textContent = messageFor(error);
        }
        calculateTotal();
    }
    function handleDateLogic(field) {
        try {
            if (field === 'in' && checkInInput.value) {
                checkOutInput.min = D.addDays(checkInInput.value, 1);
                if (!checkOutInput.value || checkOutInput.value <= checkInInput.value) checkOutInput.value = checkOutInput.min;
                const [year, month] = checkInInput.value.split('-').map(Number);
                state.currentDate = new Date(year, month - 1, 1);
            }
            checkInInput.max = checkOutInput.value ? D.addDays(checkOutInput.value, -1) : '';
            render(); updateDatesFromTariffs();
        } catch (error) { showError(error); }
    }
    checkInInput.addEventListener('change', () => handleDateLogic('in'));
    checkOutInput.addEventListener('change', () => handleDateLogic('out'));
    priceInput.addEventListener('input', () => { activeQuote = null; $('quoteHint').textContent = 'Цена указана вручную и будет сохранена для этой брони.'; calculateTotal(); });
    $('bookingForm').onsubmit = async event => {
        event.preventDefault();
        if (!canWrite()) { showError('Сейчас нет возможности сохранить бронь. Дождитесь соединения и загрузки.'); return; }
        let booking;
        try {
            booking = D.buildBooking({
                id: crypto.randomUUID(), guest: $('guestName').value.trim() || 'Гость', phone: $('guestPhone').value.trim(), notes: $('guestNotes').value.trim(),
                checkIn: checkInInput.value, checkOut: checkOutInput.value, price: priceInput.value,
                quote: quoteMatches() ? activeQuote.value : null, createdAt: new Date().toISOString()
            });
        } catch (error) { showError(error); return; }
        if (await runOperation({ type: 'add', booking })) {
            resetForm();
            if (window.innerWidth < 1024) toggleMobileView('calendar');
        }
    };

    window.downloadBackup = () => {
        if (!loaded || saving) { showError('Сначала дождитесь загрузки и завершения сохранения.'); return; }
        const exported = { ...state.data, _scaleaExport: { version: 2, exportedAt: new Date().toISOString(), source: preview ? 'demo' : 'calendar', connected: online, directRates2027: D.DIRECT_RATES_2027 } };
        const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = `scaleastay_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    window.uploadBackup = async input => {
        const file = input.files[0];
        if (!file) return;
        clearError();
        try {
            if (!canWrite()) throw new Error('Not connected');
            if (file.size > 10 * 1024 * 1024) { showError('Файл слишком большой. Допустимо до 10 МБ.'); return; }
            const prepared = D.prepareImport(JSON.parse(await file.text()));
            if (!confirm(`Добавить брони из копии (${prepared.bookings.length})? Существующие записи и тарифы сохранятся. При конфликте весь импорт будет отменён.`)) return;
            if (await runOperation({ type: 'import', bookings: prepared.bookings })) {
                $('syncBanner').textContent = 'Брони из копии проверены и сохранены. Существующие записи и тарифы сохранены.';
                toggleMobileView('calendar');
            }
        } catch (error) { showError(error instanceof SyntaxError ? 'Файл содержит некорректный JSON. Данные не изменены.' : error); }
        finally { input.value = ''; }
    };

    window.toggleMobileView = view => {
        ['navCal', 'navAdd', 'navPrices', 'navData'].forEach(id => { $(id).classList.remove('text-blue-400'); $(id).classList.add('text-slate-400'); });
        $('sidebarPanel').classList.add('hidden'); $('sidebarPanel').classList.remove('lg:block');
        $('calendarView').classList.add('hidden');
        ['mobilePricesModal', 'mobileDataModal'].forEach(id => { $(id).classList.add('hidden'); $(id).classList.remove('flex'); });
        if (view === 'calendar') { $('calendarView').classList.remove('hidden'); $('sidebarPanel').classList.add('lg:block'); $('statsBlock').classList.remove('hidden'); $('navCal').classList.add('text-blue-400'); }
        else if (view === 'add') { $('sidebarPanel').classList.remove('hidden'); if (window.innerWidth < 1024) $('statsBlock').classList.add('hidden'); $('navAdd').classList.add('text-blue-400'); }
        else if (view === 'prices') { renderPricesList('mobilePricesList'); $('mobilePricesModal').classList.remove('hidden'); $('mobilePricesModal').classList.add('flex'); $('navPrices').classList.add('text-blue-400'); }
        else if (view === 'data') { $('mobileDataModal').classList.remove('hidden'); $('mobileDataModal').classList.add('flex'); $('navData').classList.add('text-blue-400'); }
    };
    function createDiv(cls) { const div = document.createElement('div'); div.className = cls; return div; }
    function render() {
        const year = state.currentDate.getFullYear(), month = state.currentDate.getMonth();
        $('displayMonth').textContent = D.monthNames[month]; $('displayYear').textContent = year;
        const grid = $('calendarGrid'); grid.innerHTML = '';
        const first = new Date(year, month, 1).getDay(), days = new Date(year, month + 1, 0).getDate();
        for (let i = 0; i < (first === 0 ? 6 : first - 1); i++) grid.appendChild(createDiv('day-cell bg-slate-50/20'));
        for (let day = 1; day <= days; day++) {
            const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const cell = createDiv(`day-cell p-1 relative cursor-pointer hover:bg-slate-50 transition ${date === D.todayStr() ? 'day-today' : 'bg-transparent'}`);
            cell.innerHTML = `<div class="day-num text-slate-400">${day}</div>`;
            cell.onclick = () => { if (!canWrite()) { showError('Добавление станет доступно после загрузки и подключения.'); return; } checkInInput.value = date; handleDateLogic('in'); if (window.innerWidth < 1024) toggleMobileView('add'); };
            state.data.bookings.forEach(booking => {
                if (date < booking.checkIn || date > booking.checkOut) return;
                const bar = createDiv('booking-bar');
                bar.onclick = event => { event.stopPropagation(); openDeleteModal(booking.id); };
                const lastNight = D.addDays(booking.checkOut, -1), label = `${escapeHtml(booking.guest || 'Гость')}${booking.notes ? ' 📝' : ''} (${D.formatMoney(D.getBookingTotalCents(booking))})`;
                if (date === booking.checkOut) { bar.classList.add('booking-checkout'); bar.textContent = '← Выезд'; }
                else if (date === booking.checkIn) { bar.classList.add('booking-start'); if (lastNight === date) bar.style.borderRadius = '6px'; bar.innerHTML = `<span class="truncate px-1">${label}</span>`; }
                else if (date === lastNight) { bar.classList.add('booking-end'); bar.innerHTML = '&nbsp;'; }
                else { bar.classList.add('booking-mid'); bar.innerHTML = '&nbsp;'; }
                cell.appendChild(bar);
            });
            grid.appendChild(cell);
        }
        updateStats(); renderPricesList('desktopPricesList');
    }
    function updateStats() {
        const year = state.currentDate.getFullYear(), month = state.currentDate.getMonth();
        let income = 0, yearIncome = 0, occupied = 0;
        state.data.bookings.forEach(booking => {
            const nights = D.getNights(booking.checkIn, booking.checkOut);
            for (let i = 0; i < nights; i++) {
                const date = D.addDays(booking.checkIn, i), [y, m] = date.split('-').map(Number);
                if (y === year) { const cents = D.getNightCents(booking, date); yearIncome += cents; if (m === month + 1) { occupied++; income += cents; } }
            }
        });
        $('statIncome').textContent = D.formatMoney(Math.round(income));
        $('statYearIncome').textContent = D.formatMoney(Math.round(yearIncome));
        $('statOccupancy').textContent = `${Math.round(occupied / new Date(year, month + 1, 0).getDate() * 100)}%`;
        $('statDays').textContent = `${occupied} ночей`;
    }
    function renderPricesList(id) {
        const container = $(id); if (!container) return;
        container.innerHTML = D.monthNames.map((month, index) => `<div class="flex justify-between items-center p-2 rounded-lg ${state.currentDate.getFullYear() === 2027 && index === state.currentDate.getMonth() ? 'bg-blue-50 border border-blue-200' : ''}"><span class="text-xs font-bold text-slate-500">${month}</span><span class="text-sm font-black text-blue-700">${D.DIRECT_RATES_2027[index]} €</span></div>`).join('');
    }
    window.openDeleteModal = id => {
        const booking = state.data.bookings.find(record => record.id === id);
        if (!booking) return;
        $('deleteModalError').classList.add('hidden');
        state.selectedBooking = JSON.parse(JSON.stringify(booking));
        const nights = D.getNights(booking.checkIn, booking.checkOut);
        const phone = String(booking.phone || ''), cleanPhone = phone.replace(/\D/g, '');
        $('deleteModalInfo').innerHTML = `<div class="font-black text-xl mb-2">${escapeHtml(booking.guest || 'Гость')}</div>
            <div class="text-xs text-slate-500 mb-2">${escapeHtml(booking.checkIn)} → ${escapeHtml(booking.checkOut)}</div>
            <div class="font-bold text-blue-700 mb-4">${nights} ночей · ${D.formatMoney(D.getBookingTotalCents(booking))}</div>
            ${cleanPhone ? `<a href="https://wa.me/${cleanPhone}" target="_blank" rel="noopener noreferrer" class="block text-sm text-emerald-700 bg-emerald-50 p-3 rounded-lg mb-2">WhatsApp · ${escapeHtml(phone)}</a>` : ''}
            ${booking.notes ? `<div class="text-xs bg-yellow-50 p-3 rounded-lg mb-3 text-left whitespace-pre-line">${escapeHtml(booking.notes)}</div>` : ''}
            <button id="copyBookingButton" class="w-full text-xs p-3 bg-slate-50 rounded-lg">Скопировать для клининга</button>`;
        $('copyBookingButton').onclick = async event => {
            try {
                await navigator.clipboard.writeText(`Бронь: ${booking.guest || 'Гость'}\nЗаезд: ${booking.checkIn}\nВыезд: ${booking.checkOut}\nНочей: ${nights}\nСумма: ${D.formatMoney(D.getBookingTotalCents(booking))}\nЗаметки: ${booking.notes || 'нет'}`);
                event.target.textContent = '✓ Скопировано';
            } catch { showError('Не удалось скопировать. Проверьте разрешение браузера на буфер обмена.'); }
        };
        $('deleteModal').classList.remove('hidden'); renderSync();
    };
    window.closeDeleteModal = () => { if (!saving) { $('deleteModal').classList.add('hidden'); state.selectedBooking = null; } };
    $('confirmDeleteBtn').onclick = async () => {
        if (!state.selectedBooking) return;
        const expectedBooking = state.selectedBooking;
        if (await runOperation({ type: 'delete', id: expectedBooking.id, expectedBooking })) closeDeleteModal();
    };
    function changeMonth(delta) { state.currentDate.setDate(1); state.currentDate.setMonth(state.currentDate.getMonth() + delta); render(); }
    $('prevMonth').onclick = () => changeMonth(-1); $('nextMonth').onclick = () => changeMonth(1);
    window.goToToday = () => { state.currentDate = new Date(); render(); };
    document.addEventListener('keydown', event => { if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) { if (event.key === 'ArrowLeft') changeMonth(-1); if (event.key === 'ArrowRight') changeMonth(1); } });
    let touchStart = null;
    $('calendarView').addEventListener('touchstart', event => { touchStart = [event.touches[0].clientX, event.touches[0].clientY]; }, { passive: true });
    $('calendarView').addEventListener('touchend', event => {
        if (!touchStart) return;
        const dx = touchStart[0] - event.changedTouches[0].clientX, dy = touchStart[1] - event.changedTouches[0].clientY;
        if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 40) changeMonth(dx > 0 ? 1 : -1);
        touchStart = null;
    }, { passive: true });
    window.addEventListener('beforeunload', event => { if (saving) { event.preventDefault(); event.returnValue = ''; } });
    window.logout = () => {
        if (saving) { showError('Дождитесь подтверждения сохранения перед выходом.'); return; }
        if (preview) { showError('Это демонстрационный режим. Вход в рабочую базу здесь отключён.'); return; }
        if (confirm('Выйти из системы?')) auth.signOut().catch(showError);
    };

    render(); renderSync();
    if (preview) {
        $('loginScreen').classList.add('hidden'); $('appContainer').classList.remove('hidden'); $('previewBanner').classList.remove('hidden');
        adapter = window.createScaleaPreviewStore(D, { data: receiveData, connected: receiveConnection, error: receiveError });
        $('previewSecond').onclick = () => window.open('preview.html', '_blank', 'noopener');
        $('previewConnection').onclick = () => { const connected = adapter.toggleConnection(); $('previewConnection').textContent = connected ? 'Проверить без связи' : 'Восстановить связь'; };
    } else {
        try {
            firebase.initializeApp(firebaseConfig);
            auth = firebase.auth();
            auth.onAuthStateChanged(user => {
                generation++;
                if (adapter) adapter.dispose();
                adapter = null; loaded = false; online = false; saving = false; readError = false; writeError = false;
                state.data = { bookings: [] }; state.selectedBooking = null; resetForm(); clearError();
                $('deleteModal').classList.add('hidden'); render(); renderSync();
                $('loginScreen').classList.toggle('hidden', Boolean(user)); $('appContainer').classList.toggle('hidden', !user);
                if (user) adapter = firebaseAdapter(generation);
            });
            $('loginForm').onsubmit = async event => {
                event.preventDefault();
                try { await auth.signInWithEmailAndPassword($('emailInput').value.trim(), $('passwordInput').value); $('loginError').classList.add('hidden'); $('passwordInput').value = ''; }
                catch { $('loginError').textContent = 'Не удалось войти. Проверьте данные и соединение.'; $('loginError').classList.remove('hidden'); }
            };
        } catch {
            $('loginError').textContent = 'Не удалось загрузить сервис входа. Проверьте интернет и обновите страницу.';
            $('loginError').classList.remove('hidden');
        }
    }
})();
