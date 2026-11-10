# اختبار المقاصة (AccountBalanceTransfer) على Staging

> **ممنوع** تنفيذ أي أمر هنا على قاعدة الإنتاج. كل الأوامر على قاعدة اسمها `system1_staging` (أو أي اسم **غير** اسم الإنتاج).
> قبل أي أمر يكتب في القاعدة، اتأكد من `MONGODB_URI` بالأمر في الخطوة 0.

## رموز مكان التنفيذ
- 🖥️ **جهازك/سيرفر Staging** — Terminal عادي داخل فولدر `back`.
- 🐳 **داخل الـ Docker container** — بـ `docker exec`.
- 🍃 **mongosh** — شاشة mongosh متصلة بقاعدة الـ Staging.

## 1) تجهيز MongoDB كـ Replica Set (الـ transactions مش بتشتغل على standalone)

**الاختيار أ — Docker محلي (الأسهل):**
```bash
# 🖥️ تشغيل Mongo بوضع replica set + أوامر الاختبار (لازم عشان خطوة محاكاة الفشل)
docker run -d --name mongo-staging -p 27017:27017 mongo:7 \
  --replSet rs0 --bind_ip_all --setParameter enableTestCommands=1

# 🖥️ تهيئة الـ replica set (مرة واحدة)
docker exec mongo-staging mongosh --quiet --eval \
  'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'

# 🖥️ تأكد إنه PRIMARY (استنى ثواني لو ظهر SECONDARY)
docker exec mongo-staging mongosh --quiet --eval 'rs.status().members[0].stateStr'
```
**الاختيار ب — Atlas:** كلاستر Staging **منفصل تمامًا** عن الإنتاج (حتى الـ free tier بيكون replica set).

## 2) تجهيز المشروع (🖥️ داخل فولدر back)
```bash
npm ci
cp .env.example .env
# عدّل .env:
#   NODE_ENV=development
#   MONGODB_URI=mongodb://localhost:27017/system1_staging?replicaSet=rs0&directConnection=true
#   JWT_ACCESS_SECRET=<نص عشوائي طويل>   # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
**الخطوة 0 (حماية):** اتأكد إن القاعدة مش الإنتاج:
```bash
grep MONGODB_URI .env     # لازم يظهر system1_staging (أو localhost) — لو شفت اسم قاعدة الإنتاج: وقّف
```

## 3) الاختبارات الآلية — قارن قبل وبعد
```bash
# 🖥️ على نسخة الكود الأصلية (قبل التعديل) — سجّل النتيجة
npm test 2>&1 | tail -40 > /tmp/baseline.txt
# 🖥️ على النسخة المعدّلة
npm test 2>&1 | tail -40 > /tmp/after.txt
diff /tmp/baseline.txt /tmp/after.txt
npm run lint
```
المطلوب: **ما يظهرش فشل جديد** في النسخة المعدّلة مقارنة بالأصلية. (اختبارات `customerPayment` و`supplierPayment` و`customer.service` و`supplier.service` فيها موديلات مش عاملها mock — لو فشلت في الأصلية كمان فهي مشكلة قديمة مش من المقاصة.)
اختبارات المقاصة الجديدة: `tests/services/accountBalanceTransfer.rules.test.js` و`tests/routes/accountBalanceTransfer.route.test.js`.
```bash
# 🖥️ محاكاة المنطق على كود الخدمات الحقيقي (بدون Mongo) — مكمّلة مش بديلة
node --import ./tests/simulation/register.mjs tests/simulation/run.mjs
```

## 4) الفهارس بأمان (انظر القسم الأخير للتفاصيل)
```bash
# 🖥️ للقراءة فقط: إيه اللي sync-indexes هيعمله لكل الموديلات (create / DROP)؟
node scripts/account-balance-transfer-indexes.js --diff
# 🖥️ إنشاء فهارس الموديل الجديد فقط (إضافة فقط)
node scripts/account-balance-transfer-indexes.js
```
```javascript
// 🍃 تأكد: لازم تلاقي فهرس idempotencyKey فريد + partialFilterExpression، وفهرس reference فريد
use system1_staging
db.accountbalancetransfers.getIndexes()
```

## 5) تشغيل السيرفر وتسجيل الدخول
```bash
# 🖥️ مرة واحدة
npm run seed-password -- "staging-pass-123"
# 🖥️ ترمنال 1 (يفضل شغال)
npm run dev
```
```bash
# 🖥️ ترمنال 2 — تسجيل الدخول
B=http://localhost:4000/api
TOKEN=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"password":"staging-pass-123","deviceId":"staging-1"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.accessToken')
H="Authorization: Bearer $TOKEN"
```
> الـ access token عمره 15 دقيقة؛ لو رجع 401 أعد الأمر.

## 6) تجهيز بيانات الاختبار (بأرصدة افتتاحية — من غير فواتير ولا خزنة)
```bash
mk() { curl -s -X POST $B/$1 -H "$H" -H 'Content-Type: application/json' -d "{\"name\":\"$2\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data._id'; }
ob() { curl -s -X PATCH $B/$1/$2/opening-balance -H "$H" -H 'Content-Type: application/json' -d "{\"amount\":$3,\"direction\":\"$4\",\"reason\":\"تجهيز اختبار\"}" >/dev/null; }

# سيناريو A (عميل ← مورد): العميل عليه 1000، والمحل عليه للمورد 2000
C1=$(mk customers "عميل-أ");  S1=$(mk suppliers "مورد-أ")
ob customers $C1 1000 they_owe_us ;  ob suppliers $S1 2000 we_owe_them

# سيناريو B (مورد ← عميل): المورد عليه للمحل 1000، والمحل عليه للعميل 2000
C2=$(mk customers "عميل-ب");  S2=$(mk suppliers "مورد-ب")
ob suppliers $S2 1000 they_owe_us ;  ob customers $C2 2000 we_owe_them
```
**لقطة "قبل" لكل الجداول (🍃)** — احفظ الأرقام:
```javascript
use system1_staging
db.getCollectionNames().filter(n=>!['accountbalancetransfers'].includes(n))
  .forEach(n=>print(n, db[n].countDocuments(), JSON.stringify(db[n].aggregate([{$group:{_id:null,s:{$sum:{$ifNull:["$amount",0]}}}}]).toArray())));
```

## 7) سيناريوهات الاختبار (🖥️ ترمنال 2) والنتيجة المتوقعة
دالة مساعدة:
```bash
tr() { curl -s -w '\n[HTTP %{http_code}]\n' -X POST $B/account-balance-transfers -H "$H" -H 'Content-Type: application/json' -d "$1"; }
bal() { curl -s $B/$1/$2 -H "$H" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)).data.totals;`remaining=${d.remaining} creditOwed=${d.creditOwed} effect=${d.balanceTransferEffect||0}`'; }
```

| # | الأمر | المتوقع |
|---|---|---|
| 1 | عميل←مورد 1000 (جزئي: جرّب 400 الأول ثم 600) | HTTP 201؛ `bal customers $C1` → remaining=0 effect=-1000؛ `bal suppliers $S1` → remaining=1000 effect=-1000 |
| 2 | مورد←عميل 1000 | 201؛ مورد-ب: remaining=0 creditOwed=0؛ عميل-ب: creditOwed=1000 |
| 3 | تجاوز الحد (عميل←مورد بمبلغ أكبر من الأقل بين الطرفين) | 400 `EXCEEDS_TRANSFERABLE` ومعاه `transferable` |
| 4 | طبيعة غلط (عميل ليه رصيد دائن ← مورد، أو مورد عليه ← عميل مدين) | 400 `SOURCE_NATURE_INVALID` أو `DESTINATION_NATURE_INVALID` |
| 5 | مبلغ `0` و`-5` و`"abc"` و`10.005` و`""` | 400 في كل الحالات |
| 6 | نفس الحساب / عميل←عميل / مورد←مورد | 400 `UNSUPPORTED_DIRECTION` |
| 7 | حساب غير موجود (ObjectId عشوائي) | 404 |
| 8 | بدون Authorization | 401 |
| 9 | تكرار: نفس `idempotencyKey` مرتين | الاتنين 201 **وبنفس `_id`**؛ العدد في `accountbalancetransfers` = 1 |
| 10 | عمليتين من غير `idempotencyKey` | الاتنين 201 (مفيش تعارض null) |
| 11 | **تزامن** (تحت) | واحدة 201 والتانية 400 أو 409/500 مع retry؛ الرصيد النهائي صح |
| 12 | **فشل قاعدة البيانات** (تحت) | HTTP 500 **ومفيش أي أثر** في أي جدول |
| 13 | سداد مورد/عميل بعد المقاصة بمبلغ أكبر من الرصيد الجديد | 400 |
| 14 | حذف عميل/مورد عليه مقاصة | 409 `HAS_TRANSACTIONS` |

مثال أمر 1:
```bash
tr "{\"fromAccountType\":\"customer\",\"fromAccountId\":\"$C1\",\"toAccountType\":\"supplier\",\"toAccountId\":\"$S1\",\"amount\":400,\"idempotencyKey\":\"t1\"}"
```

**التزامن (11):** ارصد عميل عليه 1000 ومورد عليه 1000 (جهّز زوج جديد)، ثم:
```bash
BODY="{\"fromAccountType\":\"customer\",\"fromAccountId\":\"$C3\",\"toAccountType\":\"supplier\",\"toAccountId\":\"$S3\",\"amount\":700}"
for i in 1 2; do ( tr "$BODY" & ); done; wait
bal customers $C3   # المتوقع remaining=300 (مرة واحدة بس اتنفذت)
```
كرّر 10 مرات بأزواج جديدة. **أي مرة تظهر فيها 2 نجاح = فشل الاختبار.**

**فشل قاعدة البيانات (12):**
```bash
# 🐳 اجعل أول insert يفشل مرة واحدة (يشتغل بس لأننا شغلنا enableTestCommands)
docker exec mongo-staging mongosh --quiet --eval \
 'db.adminCommand({configureFailPoint:"failCommand",mode:{times:1},data:{failCommands:["insert"],errorCode:2}})'
# 🖥️ نفّذ مقاصة صحيحة
tr "{...مقاصة صحيحة...}"
# 🍃 تأكد: لا سجل في accountbalancetransfers، لا activitylogs/auditlogs جديدة، الرصيدين زي ما هما
# 🐳 ألغِ الفشل المبرمج
docker exec mongo-staging mongosh --quiet --eval \
 'db.adminCommand({configureFailPoint:"failCommand",mode:"off"})'
```
(اختبار إضافي: وقّف الـ container بـ `docker stop mongo-staging` أثناء الطلب وتأكد إن الواجهة بتعرض خطأ، ثم `docker start`.)

## 8) التحقق بعد كل عملية ناجحة (🍃)
```javascript
use system1_staging
// السجل: نفس المرجع للطرفين
db.accountbalancetransfers.find().sort({date:-1}).limit(3).pretty()
// صافي المركز ثابت: مجموع الأثر على العملاء − مجموع الأثر على الموردين = 0 لكل العمليات
db.accountbalancetransfers.aggregate([{$group:{_id:null,custEffect:{$sum:{$add:[
 {$cond:[{$eq:["$fromAccountType","customer"]},"$fromEffect",0]},{$cond:[{$eq:["$toAccountType","customer"]},"$toEffect",0]}]}},
 suppEffect:{$sum:{$add:[{$cond:[{$eq:["$fromAccountType","supplier"]},"$fromEffect",0]},{$cond:[{$eq:["$toAccountType","supplier"]},"$toEffect",0]}]}}}}])
// المتوقع: custEffect == suppEffect  (يعني الفرق = 0)
// قارن لقطة "بعد" بلقطة "قبل": cashboxtransactions / products / sales / purchases / *returns / expenses لازم ما تتغيّرش
db.cashboxtransactions.countDocuments(); db.products.countDocuments(); db.sales.countDocuments(); db.purchases.countDocuments()
```
وقارن أرقام صفحة **التقارير** (إجمالي مديونية العملاء/الموردين) قبل وبعد: كل رقم يتغيّر بمقدار المقاصة بالظبط، ومجموع (مديونية العملاء − مستحقات الموردين) ثابت.

## 9) فحص الواجهة (بعد `npm run dev` في فولدر front وتوجيهه للـ API)
- صفحة العميل-أ: زر «مقاصة مع مورد» شغال، النافذة تعرض المصدر والمستلم والحد الأقصى، «متابعة» ثم تأكيد، الزر بيتقفل أثناء التنفيذ، رسالة نجاح، البطاقات والسجل بيتحدثوا.
- بطاقة «أثر المقاصة مع الموردين» ظاهرة، و«المتبقي» = الإجمالي − المدفوع + الأثر.
- صفحة المورد-أ: السجل فيه **نفس رقم المرجع `ABT-…`**.
- «طباعة كشف حساب» للطرفين: قسم سجل المقاصة + سطر الأثر ظاهرين.
- موبايل (عرض ضيق) و RTL: النافذة والجدول مقروءين، الجدول بيسكرول أفقيًا.
- زر المقاصة معطّل لو مفيش مديونية (العميل) / مستحق لنا (المورد).

## 10) تنظيف (Staging فقط)
```bash
docker rm -f mongo-staging      # 🖥️ يمسح كل حاجة
```

---

# طريقة `sync-indexes` بأمان

**هل بيضيف فهارس بس؟ لأ.** `npm run sync-indexes` بيستدعي `Model.syncIndexes()` لكل الموديلات، وده:
1. **بينشئ** الفهارس الناقصة.
2. **بيحذف** أي فهرس موجود في القاعدة ومش معرّف في الـ schema (حتى لو اتعمل يدويًا).
3. لو فيه بيانات مكرّرة تخالف فهرس `unique` جديد، بناء الفهرس بيفشل (ما بيعدّلش بيانات).

مبيقرأش ولا بيعدّل ولا بيحذف **أي مستند (document)**، لكن حذف فهرس مهم ممكن يأثر على الأداء أو على ضمان فريد موجود.

**الطريقة الآمنة:**
1. على Staging: `node scripts/account-balance-transfer-indexes.js --diff` — قراءة فقط، بيعرض لكل موديل إيه هيتعمل وإيه **هيتحذف**.
2. للإنتاج (بعد اعتماد Staging، وبموافقتك وانت اللي تنفّذ): شغّل **الأمر الإضافي فقط**:
   `node scripts/account-balance-transfer-indexes.js`
   بيعمل `createIndexes()` على مجموعة `accountbalancetransfers` الجديدة الفاضية بس — مستحيل يحذف فهرس ولا يلمس مجموعة تانية.
3. متشغّلش `npm run sync-indexes` الكامل على الإنتاج إلا لو `--diff` أكد إن `toDrop` فاضية لكل الموديلات.
4. خد backup/snapshot من الإنتاج قبل أي تغيير في الفهارس.

**ليه الفهارس لازمة؟** `autoIndex` مقفول في الإنتاج. فهرس `idempotencyKey` الفريد هو اللي بيمنع تكرار العملية لو طلبين بنفس المفتاح وصلوا في نفس اللحظة. من غيره، الحماية من التكرار بتبقى جزئية (الفحص المسبق بس). وفهرس `reference` الفريد بيضمن مرجع واحد لكل عملية.
